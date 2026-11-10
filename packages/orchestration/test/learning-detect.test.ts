import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Employee, EventType, Host, Improvement, Question, Task, TaskStatus } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';
import { DETECT, busiestHours, detectors, environmentError, mayPropose, questionSimilarity, revertDetectAction, routingPreference, stretches, type Proposal } from '../src/learning/detect.ts';

/**
 * The detectors read recorded history, so every test here writes a history (tasks, questions and
 * events with the timestamps it needs) straight into an engine and asks a detector what it supports.
 * No machine is online: the scheduler never starts anything, and nothing is ever delivered to a session.
 */
const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => false, respondHook: () => false, disconnect: () => undefined };
let eng: Engine;
const id: Record<string, string> = {};
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
let n = 0;

async function project(name: string, policy: Record<string, unknown> = {}): Promise<string> {
  return (await eng.tasks.createProject({ name, policy })).id;
}
/** A task record as it would stand after the given history. `steps` are [status, how long ago]. */
function task(projectId: string, over: Partial<Task> & { steps?: Array<[TaskStatus, number]> } = {}): Task {
  const { steps = [], ...rest } = over;
  const history = steps.map(([status, msAgo]) => ({ ts: ago(msAgo), status, note: status, by: 'test' }));
  const started = steps.find(([s]) => s === 'IN_PROGRESS');
  const done = [...steps].reverse().find(([s]) => s === 'DONE');
  const t: Task = {
    id: `task-${++n}`, key: `T-${n}`, projectId, title: `Task ${n}`, description: '', acceptance: '', kind: 'feature', priority: 'normal', status: steps.length ? steps[steps.length - 1]![0] : 'DONE', assigneeId: null, roleHint: null, dependsOn: [],
    branch: null, worktree: null, baseSha: null, requiresReview: false, reviewerId: null, reviewOf: null, verifyCommand: null, released: true, nudges: 0,
    friction: { failedVerifications: 0, reviewRejections: 0, mergeConflicts: 0, blockers: 0, questions: 0, denials: 0 }, blockedReason: null, progress: { percent: null, note: null, ts: null },
    evidence: { summary: 'done', reportedTests: null, commits: [], filesChanged: [], diffStat: null, verification: null, review: null, merge: null },
    history, attempts: 0, createdBy: 'test', createdAt: ago(steps[0]?.[1] ?? DAY), updatedAt: ago(steps[steps.length - 1]?.[1] ?? HOUR), startedAt: started ? ago(started[1]) : null, completedAt: done ? ago(done[1]) : null,
    delivery: { status: 'none', via: null, ts: null, detail: null }, ...rest,
  };
  return eng.core.put('task', t);
}
const friction = (f: Partial<Task['friction']>): Task['friction'] => ({ failedVerifications: 0, reviewRejections: 0, mergeConflicts: 0, blockers: 0, questions: 0, denials: 0, ...f });
const changed = (files: string[], over: Partial<Task['evidence']> = {}): Task['evidence'] => ({ summary: 'done', reportedTests: null, commits: [], filesChanged: files, diffStat: null, verification: null, review: null, merge: null, ...over });
function event(type: EventType, msAgo: number, over: { taskId?: string; projectId?: string; employeeId?: string; hostId?: string; summary?: string; data?: Record<string, unknown> } = {}) {
  return eng.core.event({ type, source: 'server', ts: ago(msAgo), summary: over.summary ?? type, ...over })!;
}
function question(projectId: string, over: Partial<Question> & { askedAgo: number; answeredAgo?: number | null }): Question {
  const { askedAgo, answeredAgo, ...rest } = over;
  const q: Question = {
    id: `q-${++n}`, kind: 'question', channel: 'mcp_tool', employeeId: id.Alex!, sessionId: null, taskId: null, projectId, text: 'A question?', context: '', why: '', options: [], tool: null, parts: [], answers: null,
    status: answeredAgo == null ? 'open' : 'confirmed', answer: answeredAgo == null ? null : 'An answer.', decision: null, createdAt: ago(askedAgo), answeredAt: answeredAgo == null ? null : ago(answeredAgo), deliveredAt: null, confirmedAt: null, deliveryDetail: null, ...rest,
  };
  return eng.core.put('question', q);
}
/** An employee written straight into the office, so that no event of theirs exists. */
function colleague(name: string, over: Partial<Employee>): Employee {
  return eng.core.put('employee', { ...structuredClone(eng.core.employees.require(id.Alex!)), id: `emp-${name}`, name, deskId: null, ...over });
}
const found = (detector: string, projectId: string | null, at = now): Proposal[] => detectors[detector]!(eng, at).filter((p) => (p.projectId ?? null) === projectId);
const keys = (list: Proposal[]) => list.map((p) => p.key);
const fromAnalysis = (key: string): Improvement[] => eng.core.improvements.filter((i) => i.dedupeKey === key);

before(async () => {
  eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0 } }, { send: () => undefined });
  const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: ago(60 * DAY), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  id.host = host.id;
  id.home = await project('Home');
  for (const [name, role] of [['Alex', 'backend'], ['Sarah', 'backend'], ['Quinn', 'qa']] as const) id[name] = eng.employees.create({ name, roleKey: role, projectId: id.home, hostId: host.id, workingDir: '/tmp/x' }).id;
});

// ───────────────────────────── helpers of the module ─────────────────────────────

test('a task\'s own history says how long it spent in each status', () => {
  const t = task(id.home!, { steps: [['READY', 5 * HOUR], ['IN_PROGRESS', 4 * HOUR], ['READY', 3 * HOUR], ['IN_PROGRESS', 2 * HOUR], ['DONE', HOUR]] });
  const worked = stretches(t, 'IN_PROGRESS', now);
  assert.deepEqual(worked.map((s) => [Math.round((s.to - s.from) / HOUR), s.open]), [[1, false], [1, false]]);
  const waiting = task(id.home!, { steps: [['READY', 2 * HOUR]], evidence: changed([], { summary: null }) });
  assert.deepEqual(stretches(waiting, 'READY', now).map((s) => [Math.round((s.to - s.from) / HOUR), s.open]), [[2, true]]);
  eng.core.remove('task', t.id);
  eng.core.remove('task', waiting.id);
});

test('"the same hour" needs most of the incidents inside one four-hour window', () => {
  const at = (h: number, day: number) => new Date(2026, 0, day, h, 15).getTime();
  assert.deepEqual(busiestHours([at(22, 1), at(23, 2), at(1, 3), at(23, 4)]), { from: 22, to: 2, count: 4 }, 'a window may run past midnight');
  assert.equal(busiestHours([at(2, 1), at(9, 2), at(15, 3), at(21, 4)]), null, 'spread over the day: no pattern');
  assert.equal(busiestHours([at(9, 1), at(9, 2)]), null, 'two moments are not a pattern');
});

test('questions are compared by their distinctive words, and environment errors are recognised in output', () => {
  assert.ok(questionSimilarity('Which port should the dev server listen on?', 'Which port should the dev server use to listen?') >= DETECT.questionSimilarity);
  assert.ok(questionSimilarity('Which port should the dev server listen on?', 'Should the invoices table keep deleted rows?') < 0.2);
  assert.equal(questionSimilarity('Why?', 'Why?'), 0, 'too short to compare');
  assert.deepEqual(environmentError('> test\nsh: 1: vitest: not found\nELIFECYCLE'), { name: 'command not found', line: 'sh: 1: vitest: not found' });
  assert.equal(environmentError('AssertionError: expected 3 to equal 4\n  at test.ts:12')?.name, undefined, 'a failing assertion is the work, not the environment');
});

test('the same finding: not while one is undecided, not soon after a decision, and later only on new evidence', () => {
  const ev = (ids: string[]) => ids.map((x) => ({ kind: 'task' as const, id: x, note: x }));
  const imp = (over: Partial<Improvement>): Improvement => ({ id: 'i', kind: 'stall', title: 't', rationale: 'r', evidence: ev(['a', 'b']), projectId: null, employeeId: null, action: { type: 'advice' }, status: 'proposed', dedupeKey: 'k', createdAt: ago(90 * DAY), decidedAt: null, ...over });
  assert.equal(mayPropose([], ev(['a']), now), true, 'never proposed before');
  assert.equal(mayPropose([imp({})], ev(['c', 'd', 'e']), now), false, 'an earlier one is still waiting for the owner');
  assert.equal(mayPropose([imp({ status: 'dismissed', decidedAt: ago(3 * DAY) })], ev(['c', 'd', 'e']), now), false, 'dismissed recently');
  assert.equal(mayPropose([imp({ status: 'applied', decidedAt: ago(3 * DAY) })], ev(['c', 'd', 'e']), now), false, 'applied recently');
  const long = ago((DETECT.coolingOffDays + 1) * DAY);
  assert.equal(mayPropose([imp({ status: 'dismissed', decidedAt: long })], ev(['a', 'b']), now), false, 'the cooling-off is over but nothing new happened');
  assert.equal(mayPropose([imp({ status: 'dismissed', decidedAt: long })], ev(['a', 'b', 'c']), now), false, 'one new record is one incident');
  assert.equal(mayPropose([imp({ status: 'dismissed', decidedAt: long })], ev(['b', 'c', 'd']), now), true, 'two new records since: it may be said again');
  assert.equal(mayPropose([imp({ status: 'dismissed', decidedAt: long }), imp({ status: 'dismissed', decidedAt: ago(2 * DAY), evidence: ev(['c', 'd']) })], ev(['e', 'f']), now), false, 'the latest decision counts');
  // An improvement that was applied and then undone (a status this module does not know) is still a decision.
  assert.equal(mayPropose([{ ...imp({ decidedAt: long }), status: 'reverted' as Improvement['status'], revertedAt: ago(DAY) } as Improvement], ev(['c', 'd']), now), false);
});

// ───────────────────────────────── 1. task size ─────────────────────────────────

test('task size: large tasks that kept coming back → split; one such task, or small tasks just as bad → silence', async () => {
  const big = 'x'.repeat(DETECT.largeDescriptionChars);
  const p = await project('Split');
  const large = (over: Partial<Task> = {}) => task(p, { description: big, attempts: 3, friction: friction({ failedVerifications: 3 }), ...over });
  large();
  large({ description: '', evidence: changed(Array.from({ length: DETECT.largeFilesChanged }, (_, i) => `src/f${i}.ts`)), attempts: 2, friction: friction({ reviewRejections: 2 }) });
  for (let i = 0; i < 3; i++) task(p, {}); // small tasks that went through cleanly
  assert.deepEqual(keys(found('taskSize', p)), [], 'two large reworked tasks are below the minimum');
  large();
  const [split] = found('taskSize', p);
  assert.equal(split?.key, `task-size:split:${p}`);
  assert.deepEqual([split!.kind, split!.action.type, split!.evidence.length], ['task_size', 'advice', 3]);
  assert.match(split!.rationale, /3 large tasks in Split needed 3 or more attempts[\s\S]*3 of 3 large tasks, against 0 of 3 smaller ones/);
  assert.ok(split!.evidence.every((e) => e.kind === 'task' && eng.core.tasks.get(e.id)), 'the evidence is the tasks themselves');

  // Where small tasks need just as much rework, size is not what the record shows.
  const q = await project('AllBad');
  for (let i = 0; i < 3; i++) task(q, { description: big, attempts: 3, friction: friction({ failedVerifications: 3 }) });
  for (let i = 0; i < 3; i++) task(q, { attempts: 4, friction: friction({ failedVerifications: 4 }) });
  assert.deepEqual(keys(found('taskSize', q)), []);
  // Old history is not read.
  const old = await project('LongAgo');
  for (let i = 0; i < 4; i++) task(old, { description: big, attempts: 3, friction: friction({ failedVerifications: 3 }), updatedAt: ago((DETECT.lookbackDays + 5) * DAY) });
  assert.deepEqual(keys(found('taskSize', old)), []);
});

test('task size: tiny tasks in a chain → batch; tiny but unrelated, or a minority → silence', async () => {
  const tiny = (p: string, dependsOn: string[] = [], over: Partial<Task> = {}) => task(p, { steps: [['READY', 3 * HOUR], ['IN_PROGRESS', 2 * HOUR], ['DONE', 2 * HOUR - 4 * MIN]], evidence: changed(['a.ts']), dependsOn, ...over });
  const p = await project('Chain');
  let prev: string[] = [];
  for (let i = 0; i < 5; i++) prev = [tiny(p, prev).id];
  task(p, { steps: [['IN_PROGRESS', 5 * HOUR], ['DONE', 2 * HOUR]], evidence: changed(['a.ts', 'b.ts', 'c.ts']) });
  const [batch] = found('taskSize', p);
  assert.equal(batch?.key, `task-size:batch:${p}`);
  assert.match(batch!.rationale, /5 of the 6 tasks completed in Chain[\s\S]*waited for one another in a chain/);
  assert.equal(batch!.action.type, 'advice');

  const loose = await project('Loose');
  for (let i = 0; i < 6; i++) tiny(loose); // tiny, but nothing connects them
  assert.deepEqual(keys(found('taskSize', loose)), []);
  const few = await project('Few');
  let last: string[] = [];
  for (let i = 0; i < 5; i++) last = [tiny(few, last).id];
  for (let i = 0; i < 6; i++) task(few, { steps: [['IN_PROGRESS', 5 * HOUR], ['DONE', 2 * HOUR]] }); // most of the project's work is not tiny
  assert.deepEqual(keys(found('taskSize', few)), []);
  // A tiny task that failed verification is not "nothing went wrong".
  const rough = await project('Rough');
  let r: string[] = [];
  for (let i = 0; i < 5; i++) r = [tiny(rough, r, { friction: friction({ failedVerifications: 1 }) }).id];
  assert.deepEqual(keys(found('taskSize', rough)), []);
});

// ──────────────────────────────── 2. dependencies ────────────────────────────────

/** A's merge conflicted in `files`; B, another employee's task worked at the same time, changed `bFiles`. */
function conflict(p: string, files: string[], bFiles = files, msAgo = 5 * HOUR): { a: Task; b: Task } {
  const b = task(p, { assigneeId: id.Sarah!, steps: [['IN_PROGRESS', msAgo + 3 * HOUR], ['DONE', msAgo + HOUR]], evidence: changed(bFiles) });
  const a = task(p, { assigneeId: id.Alex!, steps: [['IN_PROGRESS', msAgo + 2 * HOUR], ['BLOCKED', msAgo]], evidence: changed(files), friction: friction({ mergeConflicts: 1 }) });
  event('task.merge_conflict', msAgo, { taskId: a.id, projectId: p, employeeId: id.Alex!, summary: `${a.key} could not be merged`, data: { key: a.key, conflicts: files } });
  return { a, b };
}

test('dependencies: parallel work that collided in one folder → a habit for the folder; one collision, other files, or work one after the other → silence', async () => {
  const p = await project('Collide');
  conflict(p, ['src/api/users.ts']);
  assert.deepEqual(keys(found('dependencies', p)), [], 'one incident');
  conflict(p, ['src/api/orders.ts', 'README.md'], ['src/api/orders.ts']);
  const [area] = found('dependencies', p);
  assert.equal(area?.key, `deps:area:${p}:src/api`);
  assert.deepEqual([area!.kind, area!.action.type, area!.evidence.length], ['dependencies', 'advice', 2]);
  assert.match(area!.title, /Make tasks that change src\/api\/ wait for each other/);
  assert.match(area!.rationale, /2 merges in Collide conflicted in src\/api\/ \(src\/api\/users\.ts, src\/api\/orders\.ts\)/);
  assert.ok(area!.evidence.every((e) => e.kind === 'event'));

  // The other task changed different files: these conflicts were not between parallel tasks on the same files.
  const other = await project('Elsewhere');
  conflict(other, ['src/api/users.ts'], ['docs/a.md']);
  conflict(other, ['src/api/orders.ts'], ['docs/b.md']);
  assert.deepEqual(keys(found('dependencies', other)), []);
  // The other task was finished before this one started: not parallel.
  const serial = await project('Serial');
  for (const file of ['lib/a.ts', 'lib/b.ts']) {
    task(serial, { assigneeId: id.Sarah!, steps: [['IN_PROGRESS', 9 * HOUR], ['DONE', 8 * HOUR]], evidence: changed([file]) });
    const a = task(serial, { assigneeId: id.Alex!, steps: [['IN_PROGRESS', 7 * HOUR], ['BLOCKED', 5 * HOUR]], evidence: changed([file]) });
    event('task.merge_conflict', 5 * HOUR, { taskId: a.id, projectId: serial, data: { conflicts: [file] } });
  }
  assert.deepEqual(keys(found('dependencies', serial)), []);
  // The same file twice is the existing "sequencing" finding, not a folder habit.
  const same = await project('SameFile');
  conflict(same, ['src/db/schema.ts']);
  conflict(same, ['src/db/schema.ts']);
  assert.deepEqual(keys(found('dependencies', same)), []);
});

test('dependencies: two waiting tasks that continue the lines of work that collided are linked — applying records what was there, and it can be undone', async () => {
  const p = await project('Link');
  const one = conflict(p, ['src/ui/form.tsx']);
  conflict(p, ['src/ui/table.tsx']);
  const x = task(p, { title: 'Form validation', status: 'BACKLOG', dependsOn: [one.a.id], steps: [['BACKLOG', 4 * HOUR]], evidence: changed([], { summary: null }) });
  const y = task(p, { title: 'Form layout', status: 'READY', dependsOn: [one.b.id], steps: [['READY', 3 * HOUR]], evidence: changed([], { summary: null }) });
  const link = found('dependencies', p).find((i) => i.action.type === 'task.dependsOn');
  assert.equal(link?.key, `deps:link:${y.id}:${x.id}`, 'the later task waits for the earlier one');
  assert.deepEqual(link!.action, { type: 'task.dependsOn', taskId: y.id, dependsOnTaskId: x.id });
  assert.match(link!.title, new RegExp(`Make ${y.key} wait for ${x.key}`));
  assert.ok(link!.evidence.some((e) => e.kind === 'event') && link!.evidence.some((e) => e.id === x.id) && link!.evidence.some((e) => e.id === y.id));

  eng.improver.analyze();
  const [imp] = fromAnalysis(link!.key);
  assert.equal(imp?.status, 'proposed');
  const applied = eng.improver.apply(imp!.id);
  assert.deepEqual(applied.previous, { dependsOn: [one.b.id], status: 'READY' });
  const after = eng.core.tasks.require(y.id);
  assert.deepEqual(after.dependsOn, [one.b.id, x.id]);
  assert.equal(after.status, 'BACKLOG', 'a ready task goes back to waiting…');
  assert.equal(after.released, true, '…and stays released, so it becomes ready again by itself');
  assert.match(after.history[after.history.length - 1]!.note, new RegExp(`Waits for ${x.key}`));
  assert.deepEqual(keys(found('dependencies', p)).filter((k) => k.startsWith('deps:link')), [], 'once linked, there is nothing left to propose');

  assert.match(revertDetectAction(eng, applied), new RegExp(`${y.key} no longer waits for ${x.key}`));
  assert.deepEqual(eng.core.tasks.require(y.id).dependsOn, [one.b.id]);
  assert.match(revertDetectAction(eng, applied), /nothing to undo/, 'undoing twice changes nothing');

  // A task that has started can no longer be made to wait; a circle is refused.
  const started = task(p, { status: 'IN_PROGRESS', steps: [['IN_PROGRESS', HOUR]] });
  const refused: Improvement = { ...applied, id: 'refused', status: 'proposed', action: { type: 'task.dependsOn', taskId: started.id, dependsOnTaskId: x.id } };
  eng.core.put('improvement', refused);
  assert.throws(() => eng.improver.apply('refused'), /already under way/);
  assert.equal(eng.core.improvements.require('refused').status, 'proposed', 'a refused change decides nothing');
  eng.core.put('improvement', { ...refused, action: { type: 'task.dependsOn', taskId: x.id, dependsOnTaskId: x.id } });
  assert.throws(() => eng.improver.apply('refused'), /circle/);
  eng.core.remove('improvement', 'refused');
});

// ────────────────────────────────── 3. routing ──────────────────────────────────

test('routing: one keeps failing a kind a colleague delivers first time → prefer the colleague; too few tasks, or learned routing off → silence', async () => {
  const p = await project('Route');
  for (const who of ['Alex', 'Sarah']) eng.core.put('employee', { ...eng.core.employees.require(id[who]!), alsoProjectIds: [p] });
  const bug = (who: string, f: Partial<Task['friction']> = {}) => task(p, { kind: 'bug', assigneeId: id[who]!, steps: [['IN_PROGRESS', 3 * HOUR], ['DONE', 2 * HOUR]], friction: friction(f) });
  bug('Alex', { failedVerifications: 2 });
  bug('Alex', { reviewRejections: 1 });
  for (let i = 0; i < 3; i++) bug('Sarah');
  assert.deepEqual(keys(found('routing', p)), [], 'two tasks say nothing about Alex yet');
  bug('Alex', { failedVerifications: 1 });
  const [r] = found('routing', p);
  assert.equal(r?.key, `routing:${p}:bug:${id.Sarah}`);
  assert.deepEqual(r!.action, { type: 'project.routing', projectId: p, kind: 'bug', employeeId: id.Sarah });
  assert.deepEqual([r!.kind, r!.employeeId], ['routing', id.Sarah]);
  assert.match(r!.rationale, /Alex completed 3 bug tasks in Route[\s\S]*0 passed first time \(3 failed verifications, 1 review rejections\)\. Sarah completed 3 and 3 passed first time/);
  assert.equal(r!.evidence.length, 6);

  // The owner said outcomes must not decide who gets work: nothing is proposed, and nothing accepted earlier is used.
  eng.core.updateSettings({ selfImprovement: { learnedRouting: false } } as any);
  assert.deepEqual(keys(found('routing', p)), []);
  eng.core.updateSettings({ selfImprovement: { learnedRouting: true } } as any);

  eng.improver.analyze();
  const applied = eng.improver.apply(fromAnalysis(r!.key)[0]!.id);
  assert.deepEqual(applied.previous, { employeeId: null });
  const proj = eng.core.projects.require(p);
  assert.deepEqual(proj.detectRouting, { bug: id.Sarah });
  assert.deepEqual(keys(found('routing', p)), [], 'already the preference');
  assert.equal(routingPreference(eng.core.settings, proj, 'bug', id.Sarah!).bonus, DETECT.routingPreferenceBonus);
  assert.match(routingPreference(eng.core.settings, proj, 'bug', id.Sarah!).reason!, /preferred for bug tasks in Route/);
  assert.equal(routingPreference(eng.core.settings, proj, 'bug', id.Alex!).bonus, 0);
  assert.equal(routingPreference(eng.core.settings, proj, 'feature', id.Sarah!).bonus, 0);
  assert.equal(routingPreference({ ...eng.core.settings, selfImprovement: { ...eng.core.settings.selfImprovement, learnedRouting: false } }, proj, 'bug', id.Sarah!).bonus, 0);

  assert.match(revertDetectAction(eng, applied), /bug tasks in Route are no longer given to Sarah first/);
  assert.deepEqual(eng.core.projects.require(p).detectRouting, {});

  // A colleague whose role the scheduler never gives this kind to: advice, nothing to switch on.
  const q = await project('RouteByHand');
  for (let i = 0; i < 3; i++) task(q, { kind: 'docs', assigneeId: id.Alex!, steps: [['DONE', HOUR]], friction: friction({ failedVerifications: 1 }) });
  for (let i = 0; i < 3; i++) task(q, { kind: 'docs', assigneeId: id.Quinn!, steps: [['DONE', HOUR]] });
  eng.core.put('employee', { ...eng.core.employees.require(id.Quinn!), alsoProjectIds: [q] });
  const [byHand] = found('routing', q);
  assert.equal(byHand?.action.type, 'advice');
  assert.match(byHand!.rationale, /assign docs tasks in RouteByHand to Quinn by hand/);
});

test('routing: an accepted preference decides who the scheduler gives that kind of task to', async () => {
  // Here the machine is online, so people are free and the scheduler assigns; starting the work then fails (the host runs nothing).
  const online: AgentLink = { ...link, isOnline: () => true };
  const office = new Engine({ store: new Store(':memory:'), agents: online, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0, scheduleDebounceMs: 5 } }, { send: () => undefined });
  office.core.put('host', { id: 'h', name: 'box', status: 'online', info: null, resources: null, enrolledAt: ago(DAY), lastSeenAt: null, revokedAt: null, local: true } satisfies Host);
  const p = (await office.tasks.createProject({ name: 'Shop' })).id;
  const [first, second] = ['Uma', 'Vic'].map((name) => office.employees.create({ name, roleKey: 'backend', projectId: p, hostId: 'h', workingDir: '/tmp/x' }));
  const assigned = async (kind: 'bug' | 'feature') => {
    const t = office.tasks.createTask({ projectId: p, title: `A ${kind}`, kind });
    for (let i = 0; i < 100 && !office.core.tasks.require(t.id).assigneeId; i++) await new Promise((r) => setTimeout(r, 10));
    const done = office.core.tasks.require(t.id);
    // Free them again for the next question.
    office.core.put('task', { ...done, status: 'DONE' });
    return { who: done.assigneeId, note: done.history.find((h) => /Auto-assigned/.test(h.note))?.note ?? '' };
  };
  assert.equal((await assigned('bug')).who, first!.id, 'two equally suitable people: the first one');
  const imp: Improvement = { id: 'pref', kind: 'routing', title: 'Give bug tasks in Shop to Vic first', rationale: 'r', evidence: [], projectId: p, employeeId: second!.id, action: { type: 'project.routing', projectId: p, kind: 'bug', employeeId: second!.id }, status: 'proposed', dedupeKey: 'k', createdAt: ago(HOUR), decidedAt: null };
  office.core.put('improvement', imp);
  office.improver.apply('pref');
  const bug = await assigned('bug');
  assert.equal(bug.who, second!.id, 'the preference wins');
  assert.match(bug.note, /Auto-assigned to Vic \(track record: preferred for bug tasks in Shop, a suggestion you accepted\)/);
  assert.equal((await assigned('feature')).who, first!.id, 'other kinds of work are untouched');
  revertDetectAction(office, office.core.improvements.require('pref'));
  assert.equal((await assigned('bug')).who, first!.id, 'undone: as before');
});

// ─────────────────────── 4. questions that should not be needed ───────────────────────

test('questions: an answered question asked again and again → write the answer into the project\'s notes; once, or other questions → silence', async () => {
  const p = await project('Ports');
  const first = question(p, { text: 'Which port should the dev server listen on?', askedAgo: 9 * DAY, answeredAgo: 9 * DAY - HOUR, answer: 'Port 4100, always.' });
  question(p, { text: 'Should the invoices table keep deleted rows?', askedAgo: 8 * DAY, answeredAgo: 8 * DAY - HOUR, answer: 'Yes, soft delete.' });
  question(p, { text: 'Which port should the dev server use to listen?', employeeId: id.Sarah!, askedAgo: 5 * DAY, answeredAgo: 5 * DAY - HOUR, answer: '4100.' });
  assert.deepEqual(keys(found('missingContext', p)), [], 'asked again once');
  question(p, { text: 'On which port should the dev server listen?', employeeId: id.Sarah!, askedAgo: 2 * DAY });
  const [c] = found('missingContext', p);
  assert.equal(c?.key, `context:${p}:${first.id}`);
  const line = 'Decided: "Which port should the dev server listen on?" — Port 4100, always.';
  assert.deepEqual(c!.action, { type: 'project.notes.append', projectId: p, text: line });
  assert.deepEqual([c!.kind, c!.employeeId, c!.evidence.length, c!.evidence[0]!.id], ['missing_context', id.Sarah, 3, first.id]);
  assert.match(c!.rationale, /asked again 2 times since, by Sarah[\s\S]*not in the team knowledge[\s\S]*matched by their wording/);
  assert.ok(c!.evidence.every((e) => e.kind === 'question' && eng.core.questions.get(e.id)));

  eng.core.put('project', { ...eng.core.projects.require(p), docs: 'Stack: Node 22.' });
  eng.improver.analyze();
  const applied = eng.improver.apply(fromAnalysis(c!.key)[0]!.id);
  assert.deepEqual(applied.previous, { docs: 'Stack: Node 22.' });
  assert.equal(eng.core.projects.require(p).docs, `Stack: Node 22.\n${line}`);
  assert.deepEqual(keys(found('missingContext', p)), [], 'the notes say it now');
  // The owner writes more into the notes afterwards; undoing takes out only the line that was added.
  eng.core.put('project', { ...eng.core.projects.require(p), docs: `${eng.core.projects.require(p).docs}\nDeploys go out on Fridays.` });
  assert.match(revertDetectAction(eng, applied), /taken out of Ports's notes/);
  assert.equal(eng.core.projects.require(p).docs, 'Stack: Node 22.\nDeploys go out on Fridays.');

  // A repeat only counts after the first answer was given.
  const early = await project('Early');
  question(early, { text: 'Which port should the dev server listen on?', askedAgo: 3 * DAY, answeredAgo: DAY, answer: 'Port 4100.' });
  question(early, { text: 'Which port should the dev server listen on now?', askedAgo: 2 * DAY });
  question(early, { text: 'Which port should the dev server listen on then?', askedAgo: 2 * DAY - HOUR });
  assert.deepEqual(keys(found('missingContext', early)), []);
});

// ─────────────────────────────────── 5. stalls ───────────────────────────────────

test('stalls: approvals that keep waiting for the owner are named, with the hour when they cluster; two of them are not a pattern', async () => {
  const p = await project('Waiting');
  // The same hour on three different days.
  const at = (daysAgo: number) => now - new Date(now - daysAgo * DAY).setHours(23, 10, 0, 0);
  const ask = (daysAgo: number) => question(p, { kind: 'permission', text: 'Alex wants to run: npm publish', askedAgo: at(daysAgo), answeredAgo: at(daysAgo) - 7 * HOUR, decision: 'allow', tool: { name: 'Bash', input: { command: 'npm publish' } } });
  ask(2);
  ask(3);
  question(p, { kind: 'permission', text: 'quick one', askedAgo: 5 * HOUR, answeredAgo: 5 * HOUR - 5 * MIN }); // answered in five minutes: not a wait
  assert.deepEqual(keys(found('stalls', p)), []);
  ask(4);
  const [s] = found('stalls', p);
  assert.equal(s?.key, `stall:${p}:waiting_approval`);
  assert.deepEqual([s!.kind, s!.action.type, s!.evidence.length], ['stall', 'advice', 3]);
  assert.ok(s!.evidence.every((e) => e.kind === 'approval'));
  assert.match(s!.rationale, /3 permission requests in Waiting waited more than 30 minutes[\s\S]*3 of the 3 began between \d\d:00 and \d\d:00[\s\S]*working hours that match yours/);
});

test('stalls: ready work nobody assigned while someone suitable was free → named; when they were busy → silence', async () => {
  const p = await project('Unassigned', { autoAssign: false });
  eng.core.put('employee', { ...eng.core.employees.require(id.Alex!), alsoProjectIds: [p] });
  eng.core.put('employee', { ...eng.core.employees.require(id.Sarah!), alsoProjectIds: [] });
  const wait = (hoursAgo: number, over: Partial<Task> = {}) => task(p, { steps: [['READY', hoursAgo * HOUR], ['IN_PROGRESS', (hoursAgo - 3) * HOUR], ['DONE', (hoursAgo - 4) * HOUR]], ...over });
  wait(30);
  wait(50);
  assert.deepEqual(keys(found('stalls', p)), []);
  wait(70);
  const [s] = found('stalls', p);
  assert.equal(s?.key, `stall:${p}:unassigned_no_auto`);
  assert.match(s!.rationale, /3 times[\s\S]*waited \(typically 3 hours\) with nobody assigned, while someone suitable had nothing in progress \(Alex\)[\s\S]*Switch on "auto-assign" for Unassigned/);
  // A kind nobody on the project takes is a different cause, with a different remedy.
  for (const h of [30, 50, 70]) wait(h, { kind: 'docs' });
  assert.deepEqual(keys(found('stalls', p)).sort(), [`stall:${p}:nobody_qualified`, `stall:${p}:unassigned_no_auto`]);

  // The only suitable employee was in the middle of other work the whole time: a queue, not a stall.
  const busy = await project('Queue', { autoAssign: false });
  const sam = colleague('Sam', { projectId: busy, alsoProjectIds: [] });
  task(busy, { assigneeId: sam.id, steps: [['IN_PROGRESS', 80 * HOUR], ['DONE', 20 * HOUR]] });
  for (const h of [30, 50, 70]) task(busy, { steps: [['READY', h * HOUR], ['IN_PROGRESS', (h - 3) * HOUR], ['DONE', (h - 4) * HOUR]] });
  assert.deepEqual(keys(found('stalls', busy)), []);
});

test('stalls: a disconnected machine, a paused project and an unavailable assignee are each named from the record', async () => {
  const p = await project('Offline');
  eng.core.put('employee', { ...eng.core.employees.require(id.Sarah!), alsoProjectIds: [p] });
  for (const h of [30, 60, 90]) {
    event('worker.disconnected', h * HOUR, { hostId: id.host! });
    event('worker.connected', (h - 5) * HOUR, { hostId: id.host! });
    task(p, { assigneeId: id.Sarah!, steps: [['READY', h * HOUR], ['IN_PROGRESS', (h - 5) * HOUR], ['DONE', (h - 6) * HOUR]] });
  }
  const [off] = found('stalls', p);
  assert.equal(off?.key, `stall:${p}:machine_offline`);
  assert.match(off!.rationale, /3 times[\s\S]*while "box" was disconnected from the office[\s\S]*Keep the host agent running/);

  const paused = await project('Paused');
  for (let i = 0; i < 3; i++) task(paused, { steps: [['READY', 3 * DAY]], evidence: changed([], { summary: null }) });
  assert.deepEqual(keys(found('stalls', paused)).filter((k) => /project_paused/.test(k)), [], 'the project is not paused');
  eng.core.put('project', { ...eng.core.projects.require(paused), status: 'paused' });
  assert.deepEqual(keys(found('stalls', paused)), [`stall:${paused}:project_paused`]);
  assert.match(found('stalls', paused)[0]!.rationale, /3 released tasks of Paused have been ready for 3 days[\s\S]*Resume the project/);

  const away = await project('Away');
  const rae = colleague('Rae', { projectId: away, alsoProjectIds: [], schedule: { available: false } });
  for (let i = 0; i < 3; i++) task(away, { assigneeId: rae.id, steps: [['READY', 5 * HOUR]], evidence: changed([], { summary: null }) });
  const [un] = found('stalls', away);
  assert.equal(un?.key, `stall:${away}:assignee_unavailable`);
  assert.match(un!.rationale, /wait \(typically 5 hours\) for Rae, who is marked as not available/);
});

test('stalls: work that goes quiet after the same step is reported by that step — unless a waiting question explains the silence', async () => {
  const p = await project('Quiet');
  const kim = colleague('Kim', { projectId: p, alsoProjectIds: [] });
  const run = (who: Employee, daysAgo: number): Task => {
    const start = daysAgo * DAY;
    const t = task(p, { assigneeId: who.id, steps: [['IN_PROGRESS', start], ['DONE', start - 3 * HOUR]] });
    event('task.started', start - MIN, { taskId: t.id, projectId: p, employeeId: who.id });
    event('agent.tool_started', start - 20 * MIN, { projectId: p, employeeId: who.id });
    event('task.verifying', start - 30 * MIN, { taskId: t.id, projectId: p, employeeId: who.id, summary: `Verifying ${t.key}: npm test` });
    // …and then nothing for two hours.
    event('task.completed', start - 150 * MIN, { taskId: t.id, projectId: p, employeeId: who.id });
    return t;
  };
  run(kim, 3);
  run(kim, 5);
  assert.deepEqual(keys(found('stalls', p)), []);
  run(kim, 7);
  const [s] = found('stalls', p);
  assert.equal(s?.key, `stall:${p}:quiet_after:task.verifying`);
  assert.match(s!.rationale, /3 times[\s\S]*nothing at all came from its employee for more than 45 minutes \(typically 2 hours\), each time right after verification was started/);
  assert.ok(s!.evidence.every((e) => e.kind === 'task' && /nothing from Kim for 2 hours after "Verifying T-\d+: npm test"/.test(e.note)));

  // The same silences, but each one is a question waiting for an answer: that is the cause, and it is reported as such.
  const asked = await project('Asked');
  const lee = colleague('Lee', { projectId: asked, alsoProjectIds: [] });
  for (const d of [3, 5, 7]) {
    const t = task(asked, { assigneeId: lee.id, steps: [['IN_PROGRESS', d * DAY], ['DONE', d * DAY - 3 * HOUR]] });
    event('task.started', d * DAY - MIN, { taskId: t.id, projectId: asked, employeeId: lee.id });
    event('agent.tool_started', d * DAY - 20 * MIN, { projectId: asked, employeeId: lee.id });
    event('agent.question', d * DAY - 30 * MIN, { taskId: t.id, projectId: asked, employeeId: lee.id });
    event('task.completed', d * DAY - 150 * MIN, { taskId: t.id, projectId: asked, employeeId: lee.id });
    question(asked, { employeeId: lee.id, taskId: t.id, text: `Question ${d}?`, askedAgo: d * DAY - 30 * MIN, answeredAgo: d * DAY - 145 * MIN });
  }
  assert.deepEqual(keys(found('stalls', asked)), [`stall:${asked}:waiting_answer`]);
});

// ───────────────────────────── 6. verification quality ─────────────────────────────

test('verification: a command that never fails, even on work that review sent back → it proves nothing; one such task, or a command that has failed → silence', async () => {
  const pass = (p: string, over: Parameters<typeof task>[1] = {}) => task(p, { evidence: changed(['a.ts'], { verification: { ts: ago(HOUR), command: 'npm test', exitCode: 0, passed: true, outputTail: '', durationMs: 900, provenance: 'measured' } }), ...over });
  const p = await project('Weak');
  for (let i = 0; i < 4; i++) pass(p);
  pass(p, { friction: friction({ reviewRejections: 1 }) });
  assert.deepEqual(keys(found('verificationQuality', p)), [], 'one task sent back');
  // Done, then reopened by the owner, then done again.
  pass(p, { steps: [['IN_PROGRESS', 9 * HOUR], ['DONE', 8 * HOUR], ['READY', 7 * HOUR], ['IN_PROGRESS', 6 * HOUR], ['DONE', 5 * HOUR]] });
  const [w] = found('verificationQuality', p);
  assert.match(w?.key ?? '', new RegExp(`^verify-weak:${p}:`));
  assert.deepEqual([w!.kind, w!.action.type, w!.evidence.length], ['verify_quality', 'advice', 2]);
  assert.match(w!.rationale, /"npm test" passed on 6 tasks of Weak[\s\S]*did not fail once — including on 2 tasks that a review then sent back or that were reopened/);
  assert.match(w!.evidence[1]!.note, /reopened after being done/);

  const honest = await project('Honest');
  for (let i = 0; i < 4; i++) pass(honest);
  for (let i = 0; i < 2; i++) pass(honest, { friction: friction({ reviewRejections: 1 }) });
  const failed = pass(honest, { friction: friction({ failedVerifications: 1 }) });
  event('task.verification_failed', 2 * HOUR, { taskId: failed.id, projectId: honest, data: { command: 'npm test', exitCode: 1, timedOut: false, outputTail: 'AssertionError' } });
  assert.deepEqual(keys(found('verificationQuality', honest)), [], 'a check that fails sometimes is doing its job');
});

test('verification: failures that are almost all the same environment error → fix the environment; failing assertions, or one task → silence', async () => {
  const p = await project('Env');
  const fail = (proj: string, t: Task, outputTail: string, timedOut = false) => event('task.verification_failed', 3 * HOUR, { taskId: t.id, projectId: proj, summary: `${t.key} failed verification (exit 127)`, data: { command: 'npm test', exitCode: 127, timedOut, outputTail } });
  const [a, b] = [task(p), task(p)];
  fail(p, a, '> test\nsh: 1: vitest: not found');
  fail(p, a, '> test\nsh: 1: vitest: not found');
  assert.deepEqual(keys(found('verificationQuality', p)), [], 'two failures');
  fail(p, b, '> test\nsh: 1: vitest: not found\n');
  fail(p, b, 'AssertionError: expected 3 to equal 4');
  assert.deepEqual(keys(found('verificationQuality', p)), [], '3 of 4 is below the share');
  fail(p, b, 'sh: 1: vitest: not found');
  fail(p, b, 'whatever', true); // a timeout is another finding's business
  const [e] = found('verificationQuality', p);
  assert.equal(e?.key, `verify-env:${p}:command not found`);
  assert.match(e!.rationale, /4 of the 5 failed verifications in Env[\s\S]*on 2 different tasks: "sh: 1: vitest: not found"[\s\S]*Fix the environment/);
  assert.deepEqual([e!.action.type, e!.evidence.length, e!.evidence[0]!.kind], ['advice', 4, 'event']);

  const work = await project('RealFailures');
  const [c, d] = [task(work), task(work)];
  for (const t of [c, c, d, d]) fail(work, t, 'AssertionError: expected 3 to equal 4');
  assert.deepEqual(keys(found('verificationQuality', work)), []);
  const single = await project('OneTask');
  const only = task(single);
  for (let i = 0; i < 4; i++) fail(single, only, 'Error: Cannot find module "left-pad"');
  assert.deepEqual(keys(found('verificationQuality', single)), [], 'one task breaking its own checkout is not the environment');
});

// ──────────────────────────────── 7. machine load ────────────────────────────────

test('machine load: work lost twice while a machine was out of memory → fewer sessions there; once, or losses at other times → silence', () => {
  const box2: Host = { id: 'host-2', name: 'mini', status: 'online', info: null, resources: null, enrolledAt: ago(60 * DAY), lastSeenAt: null, revokedAt: null, local: false };
  eng.core.put('host', box2);
  const dee = colleague('Dee', { hostId: box2.id, projectId: id.home!, alsoProjectIds: [] });
  const pressure = (daysAgo: number, sessions: number) => {
    event('host.resource_warning', daysAgo * DAY, { hostId: box2.id, summary: `Host "mini" is running out of resources: memory is 97% used`, data: { memUsed: 0.97, cpuPercent: 40, sessions } });
    event('host.resource_warning', daysAgo * DAY - 20 * MIN, { hostId: box2.id, summary: 'Host "mini" has recovered', data: { recovered: true } });
  };
  const loss = (msAgo: number) => {
    task(id.home!, { assigneeId: dee.id, steps: [['IN_PROGRESS', msAgo + HOUR], ['DONE', msAgo - HOUR]] });
    event('session.lost', msAgo, { hostId: box2.id, employeeId: dee.id, summary: "Dee's session stopped (tmux session gone)" });
  };
  pressure(4, 5);
  loss(4 * DAY - 5 * MIN);
  loss(10 * DAY); // lost on a day the machine was fine
  assert.deepEqual(keys(found('machineLoad', null)), [], 'one time under pressure');
  pressure(2, 4);
  assert.deepEqual(keys(found('machineLoad', null)), [], 'a second warning with nothing lost in it');
  const t = task(id.home!, { assigneeId: dee.id });
  event('task.verification_failed', 2 * DAY - 10 * MIN, { taskId: t.id, projectId: id.home!, employeeId: dee.id, summary: `${t.key} failed verification (timeout)`, data: { timedOut: true, command: 'npm test', outputTail: '' } });
  const [m] = found('machineLoad', null);
  assert.equal(m?.key, 'load:host-2');
  assert.deepEqual([m!.kind, m!.action.type], ['machine_load', 'advice']);
  assert.match(m!.title, /Run at most 3 sessions at once on "mini"/);
  assert.match(m!.rationale, /2 times[\s\S]*"mini" was measured out of memory or CPU[\s\S]*1 session stopped in the middle of a task and 1 verification timed out[\s\S]*running 4, 5 sessions[\s\S]*no setting that limits sessions per machine/);
  assert.ok(m!.evidence.length === 4 && m!.evidence.every((e) => e.kind === 'event'));
});

// ──────────────────────────────── 8. idle capacity ────────────────────────────────

test('idle capacity: someone with nothing to do for days while their kind of work waits unreleased → the owner is told; one task, recent activity, or released work → silence', async () => {
  const p = await project('Backlog');
  const ida = colleague('Ida', { projectId: p, alsoProjectIds: [], createdAt: ago(20 * DAY) });
  const waiting = (over: Partial<Task> = {}) => task(p, { status: 'BACKLOG', released: false, steps: [['BACKLOG', 4 * DAY]], evidence: changed([], { summary: null }), ...over });
  waiting();
  waiting({ kind: 'docs' }); // not a kind a backend engineer is given
  assert.deepEqual(keys(found('idleCapacity', p)), [], 'one task of their kind');
  waiting({ kind: 'bug' });
  const [i] = found('idleCapacity', p);
  assert.equal(i?.key, `idle:${p}`);
  assert.deepEqual([i!.kind, i!.action.type, i!.employeeId, i!.evidence.length], ['idle_capacity', 'advice', ida.id, 2]);
  assert.match(i!.rationale, /Ida \(Senior Backend Engineer\) has had no work and no activity for 3 days or more, while 2 tasks of the kind they take wait in Backlog's backlog without being released[\s\S]*never releases work by itself/);

  // Something came from their session yesterday: they are not asleep.
  const ev = event('session.activity', DAY, { employeeId: ida.id });
  assert.deepEqual(keys(found('idleCapacity', p)), []);
  assert.ok(ev);
  // A colleague who is asleep, but whose work is released and merely waiting its turn: nothing for the owner to do.
  const q = await project('Released');
  colleague('Jo', { projectId: q, alsoProjectIds: [], createdAt: ago(20 * DAY) });
  for (let k = 0; k < 3; k++) task(q, { status: 'BACKLOG', released: true, dependsOn: ['missing'], steps: [['BACKLOG', 4 * DAY]], evidence: changed([], { summary: null }) });
  assert.deepEqual(keys(found('idleCapacity', q)), []);
});

// ──────────────────────── through the office: propose once, respect a "no" ────────────────────────

test('analysis proposes a finding once, with its evidence; a dismissal is respected, and only new records bring it back after the cooling-off', async () => {
  const p = await project('Once');
  const big = 'x'.repeat(DETECT.largeDescriptionChars);
  for (let i = 0; i < 3; i++) task(p, { description: big, attempts: 3, friction: friction({ failedVerifications: 3 }) });
  const key = `task-size:split:${p}`;
  const first = eng.improver.analyze().filter((i) => i.dedupeKey === key);
  assert.equal(first.length, 1);
  assert.deepEqual([first[0]!.status, first[0]!.kind, first[0]!.projectId, first[0]!.evidence.length], ['proposed', 'task_size', p, 3]);
  assert.ok(eng.core.store.queryEvents({ types: ['improvement.proposed'] }).some((e) => e.data.improvementId === first[0]!.id), 'proposing is on the record');
  assert.equal(eng.improver.analyze().filter((i) => i.dedupeKey === key).length, 0, 'undecided: not proposed again');

  eng.improver.dismiss(first[0]!.id);
  task(p, { description: big, attempts: 3, friction: friction({ failedVerifications: 3 }) });
  task(p, { description: big, attempts: 3, friction: friction({ failedVerifications: 3 }) });
  assert.equal(eng.improver.analyze().filter((i) => i.dedupeKey === key).length, 0, 'dismissed recently: quiet, even with new records');
  // The cooling-off passes.
  eng.core.put('improvement', { ...eng.core.improvements.require(first[0]!.id), decidedAt: ago((DETECT.coolingOffDays + 1) * DAY) });
  const again = eng.improver.analyze().filter((i) => i.dedupeKey === key);
  assert.equal(again.length, 1, 'two tasks the dismissed proposal did not cite');
  assert.equal(fromAnalysis(key).length, 2);
  // Applying advice records nothing to reverse.
  assert.equal(eng.improver.apply(again[0]!.id).previous, undefined);

  // Self-improvement off: nothing is read, nothing is proposed.
  const off = await project('Off');
  for (let i = 0; i < 3; i++) task(off, { description: big, attempts: 3, friction: friction({ failedVerifications: 3 }) });
  eng.core.updateSettings({ selfImprovement: { enabled: false } } as any);
  assert.deepEqual(eng.improver.analyze(), []);
  eng.core.updateSettings({ selfImprovement: { enabled: true } } as any);
  assert.equal(eng.improver.analyze().filter((i) => i.dedupeKey === `task-size:split:${off}`).length, 1);
});

test('the autopilot dial: "safe" unless the owner chose otherwise, and only its three values are kept', () => {
  assert.equal(eng.core.settings.selfImprovement.autopilot, 'safe');
  assert.equal(eng.core.updateSettings({ selfImprovement: { autopilot: 'trusted' } } as any).selfImprovement.autopilot, 'trusted');
  assert.equal(eng.core.updateSettings({ selfImprovement: { autopilot: 'everything' } } as any).selfImprovement.autopilot, 'trusted', 'nonsense leaves it as it was');
  assert.equal(eng.core.updateSettings({ selfImprovement: { autopilot: 'off' } } as any).selfImprovement.autopilot, 'off');
  assert.equal(eng.core.updateSettings({ selfImprovement: { retrospectives: 'always' } } as any).selfImprovement.autopilot, 'off', 'another setting does not move the dial');
  eng.core.updateSettings({ selfImprovement: { autopilot: 'safe', retrospectives: 'friction' } } as any);
  // An office whose stored settings predate the dial.
  const store = new Store(':memory:');
  store.kvSet('settings', { selfImprovement: { enabled: true, retrospectives: 'friction', autoApproveSharedLessons: false, learnedRouting: true } });
  assert.equal(new Engine({ store, agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined }).core.settings.selfImprovement.autopilot, 'safe');
});

test('the event log can be read by the start of the event type (what the Growth window\'s "Done by itself" asks for)', () => {
  eng.core.event({ type: 'learning.applied' as EventType, source: 'server', summary: 'Applied by itself', data: { auto: true, area: 'autopilot', what: 'x', why: 'y', undo: null } });
  eng.core.event({ type: 'learning.reverted' as EventType, source: 'server', summary: 'Undone', data: { auto: true } });
  const log = eng.core.store.queryEvents({ typePrefix: 'learning.', limit: 50 });
  assert.deepEqual(log.map((e) => e.type), ['learning.applied', 'learning.reverted']);
  assert.ok(eng.core.store.queryEvents({ typePrefix: 'improvement.', limit: 500 }).every((e) => e.type.startsWith('improvement.')));
});
