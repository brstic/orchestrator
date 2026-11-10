import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Host, Improvement, Lesson, PerformanceStat, Question, Task, TaskKind } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import {
  Engine,
  FRICTION_WEIGHTS,
  OUTCOME_RULES,
  compare,
  improvementOutcomes,
  lessonOutcomes,
  lessonsGivenTo,
  measurable,
  outcomeOf,
  outcomesReport,
  retirable,
  routingEvidence,
  trendsOf,
  withRecentRecord,
  type AgentLink,
  type FinishedTask,
} from '../src/index.ts';

/**
 * Outcomes are counted from records, so the tests fabricate records: finished tasks the way the
 * office leaves them (friction counted, evidence filled in, start and end stamped), the approval
 * questions asked while they ran, lessons and applied improvements.
 */
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Monday 7 September 2026, 08:00 UTC. */
const T0 = Date.parse('2026-09-07T08:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const many = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));

interface Spec {
  day: number;
  project?: string;
  employee?: string;
  kind?: TaskKind;
  hours?: number;
  fails?: number;
  rejections?: number;
  conflicts?: number;
  blockers?: number;
  questions?: number;
  denials?: number;
  nudges?: number;
  lessonIds?: string[];
  /** Moment "day" counts from (default: the fixed Monday above). */
  from?: number;
}

let seq = 0;
function task(spec: Spec, over: Partial<Task> = {}): Task {
  const n = ++seq;
  const started = (spec.from ?? T0) + spec.day * DAY + (n % 50) * 60_000;
  const completed = started + (spec.hours ?? 2) * HOUR;
  const fails = spec.fails ?? 0;
  const rejections = spec.rejections ?? 0;
  const who = spec.employee ?? 'alex';
  const t: Task = {
    id: `task-${String(n).padStart(5, '0')}`,
    key: `T-${n}`,
    projectId: spec.project ?? 'shop',
    title: `Fix the cart total (${n})`,
    description: 'The total is wrong when a discount is applied.',
    acceptance: 'npm test passes',
    kind: spec.kind ?? 'bug',
    priority: 'normal',
    status: 'DONE',
    assigneeId: who,
    roleHint: null,
    dependsOn: [],
    branch: `task/t-${n}`,
    worktree: '/srv/shop',
    baseSha: 'a1b2c3',
    requiresReview: rejections > 0,
    reviewerId: null,
    reviewOf: null,
    verifyCommand: null,
    released: true,
    nudges: spec.nudges ?? 0,
    friction: { failedVerifications: fails, reviewRejections: rejections, mergeConflicts: spec.conflicts ?? 0, blockers: spec.blockers ?? 0, questions: spec.questions ?? 0, denials: spec.denials ?? 0 },
    blockedReason: null,
    progress: { percent: 100, note: null, ts: null },
    evidence: {
      summary: 'Fixed the rounding; tests pass.',
      reportedTests: 'npm test: 41 passed',
      commits: [{ sha: `c${n}`, subject: 'Fix cart total', author: who, ts: iso(completed) }],
      filesChanged: ['src/cart.ts'],
      diffStat: '1 file changed, 4 insertions(+), 2 deletions(-)',
      verification: { ts: iso(completed), command: 'npm test --silent', exitCode: 0, passed: true, outputTail: 'ok', durationMs: 900, provenance: 'measured' },
      review: null,
      merge: null,
    },
    history: [
      { ts: iso(started), status: 'IN_PROGRESS', note: 'Handed over', by: 'scheduler' },
      { ts: iso(completed), status: 'DONE', note: 'Verified and completed', by: 'orchestrator' },
    ],
    attempts: fails + rejections,
    createdBy: 'owner',
    createdAt: iso(started - HOUR),
    updatedAt: iso(completed),
    startedAt: iso(started),
    completedAt: iso(completed),
    delivery: { status: 'confirmed', via: 'terminal_paste', ts: iso(started), detail: null },
    ...over,
  };
  if (spec.lessonIds) t.playbookLessonIds = spec.lessonIds;
  return t;
}

let qseq = 0;
function approval(t: Task, decision: 'allow' | 'deny' = 'allow', kind: Question['kind'] = 'permission'): Question {
  return {
    id: `q-${++qseq}`, kind, channel: kind === 'permission' ? 'permission_hook' : 'mcp_tool', employeeId: t.assigneeId, sessionId: null, taskId: t.id, projectId: t.projectId,
    text: kind === 'permission' ? 'Alex wants to run: npm install left-pad' : 'Which date format do we use?', context: '', why: '', options: [],
    tool: kind === 'permission' ? { name: 'Bash', input: { command: 'npm install left-pad' } } : null, parts: [], answers: null, status: 'confirmed',
    answer: kind === 'permission' ? null : 'ISO', decision: kind === 'permission' ? decision : null, createdAt: t.startedAt!, answeredAt: t.startedAt, deliveredAt: t.startedAt, confirmedAt: t.startedAt, deliveryDetail: null,
  };
}

function lesson(id: string, day: number, over: Partial<Lesson> = {}): Lesson {
  return {
    id, scope: 'project', employeeId: null, projectId: 'shop', text: 'Run the verification command yourself before calling complete_task.', appliesWhen: 'when finishing a task', source: 'retrospective',
    evidence: [{ kind: 'task', id: 'task-00001', note: 'T-1 Fix the cart total' }], status: 'active', authoredBy: { kind: 'employee', id: 'alex', name: 'Alex' }, appliedCount: 0, createdAt: iso(T0 + day * DAY), updatedAt: iso(T0 + day * DAY), ...over,
  };
}

function improvement(id: string, day: number, over: Partial<Improvement>): Improvement {
  return { id, kind: 'allow_rule', title: 'Pre-approve "npm install …" in Shop', rationale: 'You approved 3 and denied none.', evidence: [], projectId: 'shop', employeeId: null, action: { type: 'project.policy.allow', projectId: 'shop', rule: 'Bash(npm install:*)' }, status: 'applied', dedupeKey: `k:${id}`, createdAt: iso(T0 + (day - 1) * DAY), decidedAt: iso(T0 + day * DAY), ...over };
}

const finished = (tasks: Task[], questions: Question[] = []): FinishedTask[] => tasks.filter(measurable).map((t) => ({ task: t, outcome: outcomeOf(t, questions) }));
const names = { project: (id: string) => `Project ${id}`, employee: (id: string) => id[0]!.toUpperCase() + id.slice(1) };

// ───────────────────────── one task's outcome ─────────────────────────

test('the outcome of a task is read off its record, and the friction score is the documented weighted sum', () => {
  const rough = task({ day: 0, hours: 3, fails: 2, rejections: 1, conflicts: 1, blockers: 1, questions: 2, denials: 1, nudges: 1 });
  const other = task({ day: 0 });
  const questions = [approval(rough), approval(rough), approval(rough), approval(rough, 'deny'), approval(rough, 'allow', 'question'), approval(other)];
  const o = outcomeOf(rough, questions);
  assert.deepEqual(
    { firstPass: o.firstPass, verified: o.verified, failedVerifications: o.failedVerifications, reviewRejections: o.reviewRejections, mergeConflicts: o.mergeConflicts, blockers: o.blockers, questions: o.questions, approvalsAsked: o.approvalsAsked, approvalsDenied: o.approvalsDenied, nudges: o.nudges, sentBack: o.sentBack, cycleMs: o.cycleMs, tokens: o.tokens },
    { firstPass: false, verified: true, failedVerifications: 2, reviewRejections: 1, mergeConflicts: 1, blockers: 1, questions: 2, approvalsAsked: 4, approvalsDenied: 1, nudges: 1, sentBack: 3, cycleMs: 3 * HOUR, tokens: null },
  );
  // 2 failed verifications ×3 + 1 rejection ×3 + 1 conflict ×2 + 1 blocker ×2 + 1 denial ×2 + 2 questions ×1 + 1 nudge ×1 + 4 approvals ×0.5
  assert.equal(o.frictionScore, 20);
  assert.deepEqual(FRICTION_WEIGHTS, { failedVerifications: 3, reviewRejections: 3, mergeConflicts: 2, blockers: 2, approvalsDenied: 2, questions: 1, nudges: 1, approvalsAsked: 0.5 });

  const clean = outcomeOf(other, questions);
  assert.deepEqual([clean.firstPass, clean.frictionScore, clean.approvalsAsked, clean.cycleMs], [true, 0.5, 1, 2 * HOUR]);
  assert.equal(outcomeOf(task({ day: 1 })).frictionScore, 0, 'a clean run costs nothing');
  // Without the questions, the denials the task counted itself are still known.
  assert.deepEqual([outcomeOf(rough).approvalsAsked, outcomeOf(rough).approvalsDenied], [1, 1]);
  // Tokens are reported when a task record carries them, never invented.
  assert.equal(outcomeOf(task({ day: 1 }, { tokens: 48_200 } as any)).tokens, 48_200);
  // Work in progress has no cycle time and is not a first pass; reviews and manually closed tasks are not measured.
  const running = outcomeOf(task({ day: 1 }, { status: 'IN_PROGRESS', completedAt: null }));
  assert.deepEqual([running.firstPass, running.cycleMs], [false, null]);
  assert.deepEqual([measurable(other), measurable(task({ day: 1, kind: 'review' })), measurable(task({ day: 1 }, { status: 'IN_PROGRESS' })), measurable(task({ day: 1 }, { evidence: { ...other.evidence, summary: null } }))], [true, false, false, false]);
});

// ─────────────────────────────── trends ───────────────────────────────

test('trends: by week (empty weeks included), project, employee and kind, and the last tasks against the ones before', () => {
  const tasks = [
    task({ day: 0, employee: 'alex', questions: 1 }),
    task({ day: 1, employee: 'alex', fails: 1, hours: 6 }),
    task({ day: 3, employee: 'bo', kind: 'feature', project: 'blog', hours: 4 }),
    // nothing finished in the week of 14 September
    task({ day: 14, employee: 'bo' }),
    task({ day: 15, employee: 'bo', kind: 'feature', project: 'blog' }),
  ];
  const questions = [approval(tasks[0]!), approval(tasks[0]!), approval(tasks[3]!)];
  const trends = trendsOf(tasks.map((t) => outcomeOf(t, questions)), names, T0 + 16 * DAY);
  assert.deepEqual(trends.byWeek.map((w) => [w.key, w.tasks, w.firstPassRate]), [['2026-09-07', 3, 0.667], ['2026-09-14', 0, null], ['2026-09-21', 2, 1]]);
  assert.equal(trends.byWeek[0]!.label, 'Week of 2026-09-07');
  // Week one: frictions 1 question + 2 approvals×0.5 = 2, one failed verification = 3, and 0.
  assert.deepEqual([trends.byWeek[0]!.meanFriction, trends.byWeek[0]!.questionsPerTask, trends.byWeek[0]!.approvalsPerTask, trends.byWeek[0]!.medianCycleMs], [1.667, 0.333, 0.667, 4 * HOUR]);
  assert.deepEqual(trends.byProject.map((r) => [r.key, r.label, r.tasks]), [['shop', 'Project shop', 3], ['blog', 'Project blog', 2]]);
  assert.deepEqual(trends.byEmployee.map((r) => [r.label, r.tasks, r.firstPassRate]), [['Bo', 3, 1], ['Alex', 2, 0.5]]);
  assert.deepEqual(trends.byKind.map((r) => [r.key, r.tasks]), [['bug', 3], ['feature', 2]]);
  assert.deepEqual([trends.overall.tasks, trends.overall.firstPass, trends.overall.firstPassRate], [5, 4, 0.8]);
  assert.deepEqual([trends.recent.window, trends.recent.last.tasks, trends.recent.previous.tasks], [OUTCOME_RULES.window, 5, 0]);
  // Only the last twelve weeks are listed.
  const long = trendsOf(many(30, (i) => outcomeOf(task({ day: i * 7 }))), names, T0 + 29 * 7 * DAY);
  assert.deepEqual([long.byWeek.length, long.byWeek[11]!.key, long.recent.last.tasks, long.recent.previous.tasks], [12, '2027-03-29', 20, 10]);
  assert.deepEqual(trendsOf([], names, T0).byWeek, []);
});

// ───────────────────────── did a lesson help? ─────────────────────────

/** A project lesson recorded on day 20: 12 bug tasks before it (5 passed first time) and 12 after (11 did). */
function helpingWorld() {
  const tasks = [
    ...many(12, (i) => task({ day: 1 + i, fails: i < 5 ? 0 : 1 })),
    ...many(4, (i) => task({ day: 2 + i, kind: 'feature', fails: i % 2 })), // no feature task after the lesson: nothing to compare these with
    ...many(12, (i) => task({ day: 21 + i, fails: i === 0 ? 1 : 0 })),
  ];
  return { tasks, lessons: [lesson('L-help', 20)] };
}
/** A lesson in Bo's own playbook from day 20: 11 of 12 passed first time before it, 4 of 12 after. */
function harmfulWorld(withIt = 12, id = 'L-harm', project = 'shop', employee = 'bo') {
  const tasks = [...many(12, (i) => task({ day: 1 + i, employee, project, fails: i === 0 ? 1 : 0 })), ...many(withIt, (i) => task({ day: 21 + i, employee, project, fails: i % 3 === 0 ? 0 : 1 }))];
  return { tasks, lessons: [lesson(id, 20, { scope: 'employee', employeeId: employee, projectId: null, text: 'Skip the local test run when the change is small; the office verifies anyway.' })] };
}

test('a lesson that helps: more tasks pass first time with it than comparable tasks without it', () => {
  const { tasks, lessons } = helpingWorld();
  const [o] = lessonOutcomes(lessons, finished(tasks));
  assert.deepEqual([o!.verdict, o!.reason, o!.needed, o!.basis], ['helping', null, null, 'inferred']);
  assert.deepEqual([o!.given, o!.notGiven, o!.firstPass.tasksA, o!.firstPass.tasksB], [12, 16, 12, 12], 'the four feature tasks have nothing to be compared with and are left out');
  assert.deepEqual([o!.firstPass.a, o!.firstPass.b, o!.firstPass.diff], [0.917, 0.417, 0.5]);
  assert.ok(o!.firstPass.z! >= OUTCOME_RULES.z && o!.friction.diff! < 0 && o!.friction.z! <= -OUTCOME_RULES.z);
  assert.equal(o!.line, 'given to 12 tasks: 92% first-pass, against 42% without — helping');
});

test('a lesson that harms: fewer pass first time with it', () => {
  const { tasks, lessons } = harmfulWorld();
  const [o] = lessonOutcomes(lessons, finished(tasks));
  assert.equal(o!.verdict, 'harmful');
  assert.equal(o!.line, 'given to 12 tasks: 33% first-pass, against 92% without — harmful');
  assert.equal(retirable(lessons[0]!, o!), true);
});

test('too few tasks is "not enough data", however large the difference looks', () => {
  // Two tasks with the lesson, both clean; twelve without it, all failed first.
  const tasks = [...many(12, (i) => task({ day: 1 + i, fails: 1 })), ...many(2, (i) => task({ day: 21 + i }))];
  const lessons = [lesson('L-new', 20)];
  const [o] = lessonOutcomes(lessons, finished(tasks));
  assert.deepEqual([o!.verdict, o!.reason, o!.needed], ['no_effect_yet', 'too_few', { with: 6, without: 0 }]);
  assert.deepEqual([o!.firstPass.a, o!.firstPass.b], [1, 0], 'the raw figures are still shown');
  assert.equal(o!.line, 'given to 2 tasks — not enough data: 2 of them can be compared with 12 tasks without it (same project, kind and employee); 8 are needed on each side');
  assert.equal(retirable(lessons[0]!, o!), false);
  // Seven on each side, 7/7 against 0/7: still one short.
  const seven = lessonOutcomes(lessons, finished([...many(7, (i) => task({ day: 1 + i, fails: 1 })), ...many(7, (i) => task({ day: 21 + i }))]))[0]!;
  assert.deepEqual([seven.verdict, seven.needed], ['no_effect_yet', { with: 1, without: 1 }]);
  // A lesson that was there from the start has nothing to be compared with.
  const always = lessonOutcomes([lesson('L-old', -5, { scope: 'company', projectId: null })], finished(many(30, (i) => task({ day: i }))))[0]!;
  assert.deepEqual([always.verdict, always.reason, always.given, always.needed], ['no_effect_yet', 'too_few', 30, { with: 8, without: 8 }]);
  assert.match(always.line, /^given to 30 tasks — not enough data: 0 of them can be compared with 0 tasks without it/);
  // A lesson nobody has worked with yet.
  const unused = lessonOutcomes([lesson('L-fresh', 90)], finished(tasks))[0]!;
  assert.deepEqual([unused.verdict, unused.given, unused.line], ['no_effect_yet', 0, 'not given to any finished task yet — not enough data: 8 comparable tasks are needed with it and 8 without']);
  // A lesson still waiting for the owner was never in a prompt: it is not judged.
  assert.deepEqual(lessonOutcomes([lesson('L-prop', 20, { status: 'proposed' })], finished(tasks)), []);
});

test('enough tasks but no clear difference is not a verdict; "not helping" needs a worthwhile benefit ruled out', () => {
  const flat = (n: number) => [...many(n, (i) => task({ day: 1 + i * 0.3, fails: i % 2 })), ...many(n, (i) => task({ day: 41 + i * 0.3, fails: i % 2 }))];
  const lessons = [lesson('L-flat', 40)];
  const ten = lessonOutcomes(lessons, finished(flat(10)))[0]!;
  assert.deepEqual([ten.verdict, ten.reason], ['no_effect_yet', 'unclear']);
  assert.match(ten.line, /^given to 10 tasks: 50% first-pass, against 50% without; friction 1\.5 a task, against 1\.5 without — no clear effect yet$/);
  const thirty = lessonOutcomes(lessons, finished(flat(30)))[0]!;
  assert.equal(thirty.verdict, 'no_effect_yet', 'thirty a side cannot yet rule out that it lowers friction');
  const sixty = lessonOutcomes(lessons, finished(flat(60)))[0]!;
  assert.deepEqual([sixty.verdict, sixty.reason], ['not_helping', null]);
  assert.match(sixty.line, /^given to 60 tasks: 50% first-pass, against 50% without; friction 1\.5 a task, against 1\.5 without — not helping$/);
  assert.equal(retirable(lessons[0]!, sixty), true);
  // Where work already goes well without the lesson there is nothing to measure against: no verdict, and no retiring.
  const smooth = lessonOutcomes(lessons, finished([...many(60, (i) => task({ day: 1 + i * 0.3 })), ...many(60, (i) => task({ day: 41 + i * 0.3 }))]))[0]!;
  assert.deepEqual([smooth.verdict, smooth.reason], ['no_effect_yet', 'no_room']);
  // Fewer failures but many more questions: the measures disagree, so no verdict.
  const mixed = lessonOutcomes(lessons, finished([...many(12, (i) => task({ day: 1 + i, fails: i < 9 ? 1 : 0 })), ...many(12, (i) => task({ day: 41 + i, questions: 6 }))]))[0]!;
  assert.deepEqual([mixed.verdict, mixed.reason], ['no_effect_yet', 'mixed']);
});

test('a lesson can help by lowering friction alone', () => {
  // Everything passes first time either way, but before the lesson every task asked the boss two questions.
  const tasks = [...many(10, (i) => task({ day: 1 + i, questions: 2 })), ...many(10, (i) => task({ day: 21 + i, questions: i === 0 ? 1 : 0 }))];
  const [o] = lessonOutcomes([lesson('L-asked', 20, { source: 'owner_answer', text: 'Decided by the boss — "Which date format do we use?": ISO' })], finished(tasks));
  assert.equal(o!.verdict, 'helping');
  assert.equal(o!.line, 'given to 10 tasks: 100% first-pass, against 100% without; friction 0.1 a task, against 2 without — helping');
});

test('which lessons a task was given: its own record when it has one, otherwise worked out from dates', () => {
  const lessons = [
    lesson('mine', 10, { scope: 'employee', employeeId: 'alex', projectId: null }),
    lesson('bos', 10, { scope: 'employee', employeeId: 'bo', projectId: null }),
    lesson('shop', 10),
    lesson('blog', 10, { projectId: 'blog' }),
    lesson('company', 10, { scope: 'company', projectId: null }),
    lesson('later', 30),
    lesson('waiting', 10, { status: 'proposed' }),
    lesson('gone', 10, { status: 'retired', updatedAt: iso(T0 + 15 * DAY) }),
    lesson('gone-later', 10, { status: 'retired', updatedAt: iso(T0 + 25 * DAY) }),
  ];
  assert.deepEqual(lessonsGivenTo(task({ day: 20 }), lessons), ['mine', 'shop', 'company', 'gone-later']);
  assert.deepEqual(lessonsGivenTo(task({ day: 5 }), lessons), [], 'nothing existed yet');
  assert.deepEqual(lessonsGivenTo(task({ day: 20 }, { startedAt: null }), lessons), []);
  // What the playbook recorded wins over the dates — including "none".
  assert.deepEqual(lessonsGivenTo(task({ day: 20, lessonIds: ['later', 'bos'] }), lessons), ['later', 'bos']);
  assert.deepEqual(lessonsGivenTo(task({ day: 20, lessonIds: [] }), lessons), []);

  // With recorded lessons, tasks of the same days can be told apart: here every other task was given it.
  const tasks = many(24, (i) => task({ day: 20 + i * 0.5, lessonIds: i % 2 ? ['shop'] : [], fails: i % 2 ? 0 : i % 4 ? 1 : 0 }));
  const [o] = lessonOutcomes([lessons[2]!], finished(tasks), lessons);
  assert.deepEqual([o!.basis, o!.given, o!.notGiven, o!.firstPass.a, o!.firstPass.b, o!.verdict], ['recorded', 12, 12, 1, 0.5, 'helping']);
});

test('tasks are compared like with like: a different mix of work is not mistaken for an effect', () => {
  // Bugs pass 9 times in 10, features 1 in 10 — with or without the lesson. With it the work was mostly bugs, without it mostly features.
  const batch = (day: number, kind: TaskKind, n: number, passes: number) => many(n, (i) => task({ day: day + i * 0.1, kind, fails: i < passes ? 0 : 1 }));
  const tasks = [...batch(1, 'bug', 10, 9), ...batch(3, 'feature', 30, 3), ...batch(21, 'bug', 30, 27), ...batch(25, 'feature', 10, 1)];
  const [o] = lessonOutcomes([lesson('L-mix', 20)], finished(tasks));
  // Pooled, it would look like 70% against 30%. Like with like, there is no difference at all.
  assert.deepEqual([o!.firstPass.a, o!.firstPass.b, o!.firstPass.diff], [0.7, 0.7, 0]);
  assert.notEqual(o!.verdict, 'helping');
  // Someone who joined after the lesson has no "before" of their own: their tasks are not held against it.
  const team = [...many(10, (i) => task({ day: 1 + i, fails: i === 0 ? 1 : 0 })), ...many(10, (i) => task({ day: 21 + i, fails: i === 0 ? 1 : 0 })), ...many(10, (i) => task({ day: 21 + i, employee: 'ned', fails: i === 0 ? 0 : 1 }))];
  const joined = lessonOutcomes([lesson('L-mix', 20)], finished(team))[0]!;
  assert.deepEqual([joined.given, joined.firstPass.tasksA, joined.firstPass.a, joined.firstPass.b, joined.verdict], [20, 10, 0.9, 0.9, 'no_effect_yet']);
  // The task a lesson was learned from is on neither side: it is trouble by selection.
  const source = task({ day: 19, fails: 3 });
  const learned = lessonOutcomes([lesson('L-src', 20, { evidence: [{ kind: 'task', id: source.id, note: source.key }] })], finished([source, ...many(9, (i) => task({ day: 1 + i })), ...many(9, (i) => task({ day: 21 + i }))]))[0]!;
  assert.deepEqual([learned.given, learned.notGiven, learned.firstPass.b], [9, 9, 1]);
  // The comparison itself: nothing to compare, and one cell on each side only.
  const none = compare([], [], () => 1, true);
  assert.deepEqual([none.tasksA, none.a, none.z], [0, null, null]);
  const apart = compare([outcomeOf(task({ day: 1, kind: 'bug' }))], [outcomeOf(task({ day: 1, kind: 'docs' }))], () => 1, true);
  assert.deepEqual([apart.tasksA, apart.tasksB, apart.diff], [0, 0, null]);
});

// ──────────────────── did an applied improvement help? ────────────────────

/** Bo was given more autonomy on day 30: fewer approvals asked afterwards, but the work stopped passing first time. */
function autonomyWorld(employee = 'bo', project = 'shop') {
  const before = many(10, (i) => task({ day: 15 + i, employee, project, fails: i === 0 ? 1 : 0 }));
  const after = many(10, (i) => task({ day: 31 + i, employee, project, fails: i < 8 ? 1 : 0 }));
  const questions = before.flatMap((t) => [approval(t), approval(t)]);
  const imp = improvement('imp-auto', 30, { kind: 'autonomy', title: 'Give Bo standard autonomy', projectId: null, employeeId: employee, action: { type: 'employee.autonomy', employeeId: employee, level: 'standard' } });
  return { tasks: [...before, ...after], questions, imp };
}

test('an applied improvement, before and after: each kind is judged on its own measure', () => {
  // An allow rule: approvals asked per task.
  const before = many(10, (i) => task({ day: 15 + i }));
  const straddling = task({ day: 29.5, hours: 30 });
  const after = many(10, (i) => task({ day: 31 + i }));
  const questions = [...before.flatMap((t) => [approval(t), approval(t), approval(t)]), ...after.filter((_, i) => i % 2).map((t) => approval(t)), ...many(5, () => approval(straddling))];
  const outcomes = [...before, straddling, ...after].map((t) => outcomeOf(t, questions));
  const [allow] = improvementOutcomes([improvement('imp-allow', 30, {})], outcomes);
  assert.deepEqual([allow!.verdict, allow!.metric.key, allow!.metric.better, allow!.metric.before, allow!.metric.after], ['helping', 'approvalsAsked', 'lower', 3, 0.5]);
  assert.deepEqual([allow!.before.tasks, allow!.after.tasks, allow!.projectId, allow!.employeeId], [10, 10, 'shop', null], 'the task under way when it was applied belongs to neither side');
  assert.equal(allow!.line, 'approvals asked per task: 3 before (10 tasks), 0.5 after (10 tasks) — helping');
  assert.equal(allow!.guard!.diff, 0, 'and the first-pass rate did not fall');

  // More autonomy: fewer approvals, but the first-pass rate collapsed — the guard decides.
  const auto = autonomyWorld();
  const [harm] = improvementOutcomes([auto.imp], auto.tasks.map((t) => outcomeOf(t, auto.questions)));
  assert.deepEqual([harm!.verdict, harm!.metric.before, harm!.metric.after, harm!.guard!.b, harm!.guard!.a, harm!.employeeId], ['harmful', 2, 0, 0.9, 0.2, 'bo']);
  assert.equal(harm!.line, 'approvals asked per task: 2 before (10 tasks), 0 after (10 tasks); first-pass rate fell from 90% to 20% — harmful');

  // A review gate switched on is judged on what it catches.
  const gate = improvement('imp-review', 30, { kind: 'review_policy', title: 'Require review on Shop', action: { type: 'project.requireReview', projectId: 'shop', value: true } });
  const reviewed = [...many(10, (i) => task({ day: 15 + i })), ...many(10, (i) => task({ day: 31 + i, rejections: i % 2 }))].map((t) => outcomeOf(t));
  const [review] = improvementOutcomes([gate], reviewed);
  assert.deepEqual([review!.verdict, review!.metric.label, review!.metric.better, review!.metric.after], ['helping', 'problems caught by review per task', 'higher', 0.5]);

  // A longer verification timeout: failed verifications per task. Three tasks since: not enough.
  const timeout = improvement('imp-timeout', 30, { kind: 'verify_timeout', title: "Raise Shop's verification timeout to 600s", action: { type: 'project.verifyTimeout', projectId: 'shop', seconds: 600 } });
  const few = [...many(10, (i) => task({ day: 15 + i, fails: 2 })), ...many(3, (i) => task({ day: 31 + i }))].map((t) => outcomeOf(t));
  const [soon] = improvementOutcomes([timeout], few);
  assert.deepEqual([soon!.verdict, soon!.reason, soon!.needed, soon!.metric.key], ['no_effect_yet', 'too_few', { before: 0, after: 5 }, 'failedVerifications']);
  assert.equal(soon!.line, 'failed verifications per task — not enough data: 10 tasks before the change can be compared with 3 after it (same project, kind and employee); 8 are needed on each side');

  // Only applied improvements are measured, and never a suggestion to undo one.
  assert.deepEqual(improvementOutcomes([improvement('p', 30, { status: 'proposed', decidedAt: null }), improvement('d', 30, { status: 'dismissed' }), improvement('r', 30, { kind: 'revert_improvement', action: { type: 'advice' } })], outcomes), []);
  // Other people's projects do not count towards a project's change.
  const elsewhere = [...before, ...after].map((t) => outcomeOf({ ...t, projectId: 'blog' }, questions));
  assert.equal(improvementOutcomes([improvement('imp-allow', 30, {})], elsewhere)[0]!.reason, 'too_few');
});

// ───────────────────────── the employee's record ─────────────────────────

test("the employee's record for routing: recent work counts more, a short record speaks quietly, an old one not at all", () => {
  const now = T0 + 400 * DAY;
  const ago = (days: number, employee: string, fails = 0) => outcomeOf(task({ day: 400 - days - 1, employee, fails }));
  const outcomes = [
    ...many(2, () => ago(1, 'bo')), // two fresh clean tasks
    ...many(20, () => ago(1, 'vet')), // twenty fresh clean tasks
    ...many(6, () => ago(300, 'old')), // six clean tasks, ten months ago
    ...many(6, () => ago(120, 'cy', 1)), // failed six in a row four months ago…
    ...many(3, () => ago(1, 'cy')), // …and passed the last three
    ago(1, 'one'),
  ];
  const row = (employeeId: string, completed: number, firstPass: number): PerformanceStat => ({ employeeId, kind: 'bug', completed, firstPass, failedVerifications: completed - firstPass, reviewRejections: 0, mergeConflicts: 0 });
  const rows = withRecentRecord([row('bo', 2, 2), row('vet', 20, 20), row('old', 6, 6), row('cy', 9, 3), row('one', 1, 1), row('nobody', 0, 0)], outcomes, now);
  const of = (id: string) => rows.find((r) => r.employeeId === id)!;
  assert.ok(of('bo').outcomes!.weight > 1.9 && of('bo').outcomes!.weight <= 2);
  assert.equal(of('nobody').outcomes, undefined);
  const bonus = (id: string) => routingEvidence(of(id), 'bug');
  // 2/2 used to be worth the full +2; now it is about +1, and twenty clean tasks are worth more.
  assert.ok(Math.abs(bonus('bo').bonus - 1) < 0.05 && bonus('vet').bonus > 1.7 && bonus('vet').bonus <= 2);
  assert.equal(bonus('bo').reason, '2/2 bug tasks passed first time');
  assert.deepEqual(bonus('old'), { bonus: 0, reason: null }, 'ten months on, six tasks weigh less than one');
  assert.deepEqual(bonus('one'), { bonus: 0, reason: null }, 'one task is not a record');
  // Cy's raw record is 3/9, which used to mean −0.67; counted with decay it is positive, and the reason says so.
  assert.ok(bonus('cy').bonus > 0.5);
  assert.match(bonus('cy').reason!, /^3\/9 bug tasks passed first time, 7\d% counting recent work more$/);
  assert.deepEqual(routingEvidence(undefined, 'bug'), { bonus: 0, reason: null });
});

// ───────────────────────────── the report ─────────────────────────────

test('the report is the same whatever order the records come in, and whenever it is asked for', () => {
  // Three things going on at once, each in its own project so that they do not blur each other.
  const a = helpingWorld();
  const b = harmfulWorld(12, 'L-harm', 'blog');
  const c = autonomyWorld('cy', 'docs');
  const input = { tasks: [...a.tasks, ...b.tasks, ...c.tasks], questions: c.questions, lessons: [...a.lessons, ...b.lessons], improvements: [c.imp], names, now: T0 + 60 * DAY };
  const first = outcomesReport(input);
  const again = outcomesReport(input);
  const shuffled = outcomesReport({ ...input, tasks: [...input.tasks].reverse(), questions: [...input.questions].reverse() });
  assert.deepEqual(again, first);
  assert.deepEqual(shuffled, first);
  assert.deepEqual([first.tasks, first.lessons.map((l) => l.verdict), first.improvements.map((i) => i.verdict)], [72, ['helping', 'harmful'], ['harmful']]);
  assert.deepEqual(first.thresholds, { minTasksPerSide: 8, minTasksToRetire: 12, minTasksForNoBenefit: 20, minFirstPassDifference: 0.15, confidence: 0.95, confidenceNoBenefit: 0.8, window: 20 });
  assert.equal(JSON.stringify(first).includes('null,null,null,null,null,null,null,null'), false);
  // A scope leaves out what the asker may not see, and counts only from the rest.
  const scoped = outcomesReport({ ...input, scope: { task: (t) => t.assigneeId !== 'bo', employee: (id) => id !== 'bo', project: () => true } });
  assert.deepEqual([scoped.tasks, scoped.lessons.map((l) => l.lessonId), scoped.trends.byEmployee.map((r) => r.key).sort()], [48, ['L-help'], ['alex', 'cy']]);
});

// ───────────────────────── acting on it, in an office ─────────────────────────

const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
async function office() {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { foremanSettleMs: 0, deliverySettleMs: 0 } }, { send: () => undefined });
  const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const shop = (await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } })).id;
  const blog = (await eng.tasks.createProject({ name: 'Blog', policy: { autoAssign: false } })).id;
  const hire = (name: string) => eng.employees.create({ name, roleKey: 'backend', projectId: shop, hostId: host.id, workingDir: '/tmp/x' }).id;
  const load = (w: { tasks: Task[]; lessons?: Lesson[]; questions?: Question[] }) => {
    for (const t of w.tasks) eng.core.put('task', t);
    for (const l of w.lessons ?? []) eng.core.put('lesson', l);
    for (const q of w.questions ?? []) eng.core.put('question', q);
  };
  const events = (type: string) => eng.core.store.queryEvents({ types: [type], limit: 100 });
  return { eng, shop, blog, alex: hire('Alex'), bo: hire('Bo'), cy: hire('Cy'), dana: hire('Dana'), load, events };
}

test('the periodic pass retires a lesson only past the thresholds, never with the setting off, never the owner\'s own words, and only once', async () => {
  const o = await office();
  const { eng } = o;
  // Bo's lesson: harmful, 12 tasks given it. Cy's: just as harmful, but only 9 tasks so far. Alex's: harmful, 12 tasks, taught by the owner.
  o.load(harmfulWorld(12, 'L-harm', o.shop, o.bo));
  o.load(harmfulWorld(9, 'L-early', o.shop, o.cy));
  const owners = harmfulWorld(12, 'L-owner', o.shop, o.alex);
  o.load({ tasks: owners.tasks, lessons: [{ ...owners.lessons[0]!, source: 'owner', authoredBy: { kind: 'owner', id: null, name: 'Boss' } }] });
  // And a lesson for the Blog project that helps.
  const helping = helpingWorld();
  o.load({ tasks: helping.tasks.map((t) => ({ ...t, projectId: o.blog, assigneeId: o.dana })), lessons: [{ ...helping.lessons[0]!, projectId: o.blog }] });
  const status = () => ['L-harm', 'L-early', 'L-owner', 'L-help'].map((id) => eng.core.lessons.require(id).status);
  assert.deepEqual(eng.improver.outcomes.report().lessons.map((l) => [l.lessonId, l.verdict]), [['L-harm', 'harmful'], ['L-early', 'harmful'], ['L-owner', 'harmful'], ['L-help', 'helping']]);
  assert.equal(eng.core.settings.selfImprovement.outcomesAutoRetire, true, 'on by default');

  // Setting off: nothing is retired. (Marking what helps as proven is not retiring, and still happens.)
  eng.core.updateSettings({ selfImprovement: { outcomesAutoRetire: false } } as any);
  eng.improver.outcomes.act();
  assert.deepEqual(status(), ['active', 'active', 'active', 'active']);
  assert.equal(o.events('learning.retired').length, 0);
  assert.equal(eng.core.lessons.require('L-help').proven, true);
  const proven = o.events('learning.proven');
  assert.equal(proven.length, 1);
  assert.deepEqual([proven[0]!.data.auto, proven[0]!.data.area, proven[0]!.data.undo, proven[0]!.projectId], [true, 'outcomes', { type: 'lesson.proven', lessonId: 'L-help', proven: false }, o.blog]);
  assert.equal(proven[0]!.data.why, 'given to 12 tasks: 92% first-pass, against 42% without — helping');

  // Self-improvement off altogether: nothing at all.
  eng.core.updateSettings({ selfImprovement: { enabled: false, outcomesAutoRetire: true } } as any);
  assert.deepEqual(eng.improver.outcomes.act(), []);
  assert.deepEqual(status(), ['active', 'active', 'active', 'active']);

  // On: the one lesson that is past the threshold and the office's own to retire goes — through the scheduled analysis.
  eng.core.updateSettings({ selfImprovement: { enabled: true } } as any);
  eng.improver.analyze();
  assert.deepEqual(status(), ['retired', 'active', 'active', 'active']);
  const retired = o.events('learning.retired');
  assert.equal(retired.length, 1);
  const data = retired[0]!.data as any;
  assert.deepEqual([data.auto, data.area, data.lessonId, data.undo, retired[0]!.employeeId], [true, 'outcomes', 'L-harm', { type: 'lesson.status', lessonId: 'L-harm', status: 'active' }, o.bo]);
  assert.equal(data.why, 'given to 12 tasks: 33% first-pass, against 92% without — harmful');
  assert.deepEqual([data.evidence.verdict, data.evidence.given, data.evidence.firstPass.a, data.evidence.firstPass.b, data.evidence.firstPass.tasksA], ['harmful', 12, 0.333, 0.917, 12]);
  assert.match(retired[0]!.summary, /^Orchestrator retired a lesson that was making things worse: Skip the local test run/);
  const gone = eng.core.lessons.require('L-harm');
  assert.deepEqual([gone.outcomesRetired!.verdict, gone.outcomesRetired!.why, gone.proven], ['harmful', data.why, false]);
  // The report still shows why, and a retired lesson is no longer part of anyone's prompt.
  assert.deepEqual(eng.improver.outcomes.report().lessons.find((l) => l.lessonId === 'L-harm')!.status, 'retired');
  assert.ok(!eng.improver.lessonsFor(eng.core.employees.require(o.bo), o.shop).some((l) => l.id === 'L-harm'));

  // Running it again changes nothing.
  eng.improver.analyze();
  assert.deepEqual([o.events('learning.retired').length, o.events('learning.proven').length], [1, 1]);

  // Undo: the owner re-activates it. From then on it is theirs — never retired automatically again.
  eng.improver.updateLesson('L-harm', { status: 'active' });
  eng.improver.analyze();
  assert.equal(eng.core.lessons.require('L-harm').status, 'active');
  assert.equal(o.events('learning.retired').length, 1);

  // Cy's lesson reaches twelve tasks: now it goes too.
  o.load({ tasks: many(3, (i) => task({ day: 40 + i, employee: o.cy, project: o.shop, fails: 1 })) });
  eng.improver.analyze();
  assert.deepEqual(status(), ['active', 'retired', 'active', 'active']);
  assert.equal(o.events('learning.retired').length, 2);
});

test('a lesson that stops helping loses its proven mark; one that never mattered is retired as not helping', async () => {
  const o = await office();
  const { eng } = o;
  const flat = (n: number) => [...many(n, (i) => task({ day: 1 + i * 0.3, project: o.shop, employee: o.alex, fails: i % 2 })), ...many(n, (i) => task({ day: 41 + i * 0.3, project: o.shop, employee: o.alex, fails: i % 2 }))];
  o.load({ tasks: flat(60), lessons: [lesson('L-flat', 40, { projectId: o.shop, proven: true }), lesson('L-said', 40, { projectId: o.shop, proven: true, source: 'owner_answer', text: 'Decided by the boss — "Tabs or spaces?": spaces' })] });
  eng.improver.outcomes.act();
  assert.deepEqual([eng.core.lessons.require('L-flat').status, eng.core.lessons.require('L-flat').outcomesRetired!.verdict], ['retired', 'not_helping']);
  assert.match(String(o.events('learning.retired')[0]!.summary), /made no measurable difference/);
  // The boss's decision is never retired by the office, but it is no longer preferred as proven.
  assert.deepEqual([eng.core.lessons.require('L-said').status, eng.core.lessons.require('L-said').proven], ['active', false]);
  assert.deepEqual(o.events('learning.unproven').map((e) => e.data.lessonId), ['L-said']);
});

test('an applied improvement that made things worse: its undoing is suggested once, to the owner, and nothing is reverted', async () => {
  const o = await office();
  const { eng } = o;
  const w = autonomyWorld(o.bo, o.shop);
  o.load(w);
  eng.core.put('improvement', w.imp);
  const before = eng.core.employees.require(o.bo).autonomy;
  const suggested = eng.improver.analyze().filter((i) => i.kind === 'revert_improvement');
  assert.equal(suggested.length, 1);
  const s = suggested[0]!;
  assert.deepEqual([s.status, s.action, s.outcomesRevertOf, s.employeeId, s.title], ['proposed', { type: 'advice' }, 'imp-auto', o.bo, 'Undo "Give Bo standard autonomy"']);
  assert.match(s.rationale, /approvals asked per task: 2 before \(10 tasks\), 0 after \(10 tasks\); first-pass rate fell from 90% to 20% — harmful/);
  assert.match(s.rationale, /Nothing has been undone/);
  assert.equal(s.evidence.length, 8);
  assert.equal(eng.core.employees.require(o.bo).autonomy, before, 'reverting is not this module\'s to do');
  assert.equal(eng.core.improvements.require('imp-auto').status, 'applied');
  const ev = eng.core.store.queryEvents({ types: ['improvement.proposed'], limit: 50 }).find((e) => e.data.improvementId === s.id)!;
  assert.deepEqual([ev.data.auto, ev.data.area, ev.data.revertOf, ev.data.undo], [true, 'outcomes', 'imp-auto', { type: 'improvement.dismiss', improvementId: s.id }]);
  assert.equal(eng.improver.outcomes.report().improvements[0]!.revertProposalId, s.id);
  // Not again — not on the next pass, and not after the owner dismissed it.
  assert.equal(eng.improver.analyze().filter((i) => i.kind === 'revert_improvement').length, 0);
  eng.improver.dismiss(s.id);
  assert.equal(eng.improver.analyze().filter((i) => i.kind === 'revert_improvement').length, 0);
  assert.equal(eng.core.improvements.filter((i) => i.kind === 'revert_improvement').length, 1);
});

test('in the office: performance carries the decayed record, routing reads it, and verdicts are only recomputed when something changed', async () => {
  const o = await office();
  const { eng } = o;
  const now = Date.now();
  o.load({ tasks: [...many(2, (i) => task({ day: -2 + i * 0.1, from: now, employee: o.bo, project: o.shop })), ...many(6, (i) => task({ day: -300 + i, from: now, employee: o.alex, project: o.shop }))], lessons: [lesson('L-any', 0, { projectId: o.shop })] });
  const perf = eng.improver.performance();
  const bo = perf.find((r) => r.employeeId === o.bo)!;
  assert.deepEqual([bo.completed, bo.firstPass, bo.kind], [2, 2, 'bug'], 'the counts are what they were');
  assert.ok(bo.outcomes!.weight > 1.9 && bo.outcomes!.routingRate > 0.74 && bo.outcomes!.routingRate <= 0.75);
  const bonus = eng.improver.routingBonus(eng.core.employees.require(o.bo), 'bug');
  assert.ok(Math.abs(bonus.bonus - 1) < 0.05);
  assert.equal(bonus.reason, '2/2 bug tasks passed first time');
  assert.deepEqual(eng.improver.routingBonus(eng.core.employees.require(o.alex), 'bug'), { bonus: 0, reason: null }, 'a record from ten months ago has no say');
  assert.deepEqual(eng.improver.routingBonus(eng.core.employees.require(o.bo), 'docs'), { bonus: 0, reason: null });
  eng.core.updateSettings({ selfImprovement: { learnedRouting: false } } as any);
  assert.deepEqual(eng.improver.routingBonus(eng.core.employees.require(o.bo), 'bug'), { bonus: 0, reason: null });

  const first = eng.improver.outcomes.report();
  assert.equal(eng.improver.outcomes.report().lessons, first.lessons, 'nothing changed: the verdicts are the ones already worked out');
  eng.core.put('task', task({ day: -1, from: now, employee: o.bo, project: o.shop, fails: 1 }));
  const second = eng.improver.outcomes.report();
  assert.notEqual(second.lessons, first.lessons);
  assert.deepEqual([first.tasks, second.tasks, second.trends.byEmployee.map((r) => r.label).sort()], [8, 9, ['Alex', 'Bo']]);
});
