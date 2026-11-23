import type {
  EvidenceRef,
  Improvement,
  ImprovementOutcome,
  Lesson,
  LessonOutcome,
  OutcomeComparison,
  OutcomeStats,
  OutcomeTrendRow,
  OutcomeTrends,
  OutcomeUndecided,
  OutcomeVerdict,
  OutcomesReport,
  PerformanceStat,
  Question,
  Task,
  TaskKind,
  TaskOutcome,
} from '@orchestrator/contracts';
import { newId, nowIso, truncate } from '@orchestrator/contracts';
import type { Engine } from '../engine.ts';

/**
 * Outcomes: does the office know whether what it learned helped?
 *
 * Everything here is counted from records the office already keeps — tasks, the questions and
 * approvals asked while they ran, lessons, applied improvements. Nothing is delivered to a
 * session, so none of it spends Claude usage.
 *
 *   outcomeOf        one finished task as a small record, with a friction score
 *   trendsOf         first-pass rate, friction, questions, approvals and cycle time, by week / project / employee / kind
 *   lessonOutcomes   tasks given a lesson against comparable tasks that were not → a verdict
 *   improvementOutcomes   tasks before an applied change against tasks after it → a verdict
 *   Outcomes.act     retires lessons the record is against, marks the ones it is for as proven,
 *                    and suggests undoing an applied change that made things worse
 *
 * The comparisons are observational (before/after, given/not given), not experiments: the rules
 * below are deliberately slow to speak. See docs/learning/outcomes.md.
 */

// ───────────────────────────── the rules ─────────────────────────────

/**
 * What one of each costs in the friction score. A failed verification or a rejected review is a
 * whole extra round of work (3); a conflict, a blocker or a denied action stops the work until
 * someone steps in (2); a question or a nudge is one interruption (1); an approval request is a
 * short one (0.5 — a denied one therefore counts 2.5 in all).
 */
export const FRICTION_WEIGHTS = { failedVerifications: 3, reviewRejections: 3, mergeConflicts: 2, blockers: 2, approvalsDenied: 2, questions: 1, nudges: 1, approvalsAsked: 0.5 } as const;

export const OUTCOME_RULES = {
  /** Comparable tasks needed on each side before any verdict other than "not enough data". */
  minTasksPerSide: 8,
  /** Tasks given a lesson before a `harmful` verdict may retire it. */
  minTasksToRetire: 12,
  /** Tasks on the lesson's (or the "after") side before "no worthwhile benefit" can be concluded. */
  minTasksForNoBenefit: 20,
  /** A first-pass rate has to move by at least this much (15 points) to count. */
  minFirstPassDifference: 0.15,
  /** A per-task count or the friction score has to move by a fifth of its baseline, and at least this much. */
  minCountDifference: 0.25,
  minCountShare: 0.2,
  /** One-sided 95%: to be called better or worse, a difference must be at least 1.645 standard errors from zero. */
  z: 1.645,
  confidence: 0.95,
  /**
   * One-sided 80%: "no worthwhile benefit" is concluded when the minimum that matters lies more than 0.84
   * standard errors above what was measured. A lower bar on purpose: all it leads to is retiring a lesson,
   * which is recorded and undone with one click, and at 95% it would take well over a hundred tasks a side.
   */
  zNoBenefit: 0.84,
  confidenceNoBenefit: 0.8,
  /** Tasks looked at on each side of an applied improvement, and in the "recent" trend. */
  window: 20,
  /** Weeks in the weekly trend. */
  weeks: 12,
  /** Routing: a finished task loses half its weight every this many days… */
  halfLifeDays: 45,
  /** …and a record has a say once it holds two tasks whose weights add up to at least this. */
  routingMinTasks: 2,
  routingMinWeight: 1.5,
} as const;

const DAY = 86_400_000;
const Z_CAP = 99;
const EPS = 1e-9;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]): number | null => (xs.length ? sum(xs) / xs.length : null);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const pct = (n: number | null): string => (n === null ? '—' : `${Math.round(n * 100)}%`);
const num = (n: number | null): string => (n === null ? '—' : String(Number(n.toFixed(2))));

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ───────────────────────── one task's outcome ─────────────────────────

/** Tokens on a task, if a later version of the task record carries them (`tokens`, or a `usage` like a session's). */
function tokensOf(task: Task): number | null {
  const t = task as unknown as { tokens?: unknown; usage?: { inputTokens?: unknown; outputTokens?: unknown } | null };
  if (typeof t.tokens === 'number' && Number.isFinite(t.tokens)) return t.tokens;
  if (t.usage && typeof t.usage.inputTokens === 'number' && typeof t.usage.outputTokens === 'number') return t.usage.inputTokens + t.usage.outputTokens;
  return null;
}

/**
 * A task as a small record of what it cost. `questions` are the office's questions (all of them or
 * just this task's): the approvals asked while the task ran are counted from them. Without them,
 * only the denials the task itself counted are known.
 */
export function outcomeOf(task: Task, questions: readonly Question[] = []): TaskOutcome {
  const f = task.friction ?? { failedVerifications: 0, reviewRejections: 0, mergeConflicts: 0, blockers: 0, questions: 0, denials: 0 };
  const permissions = questions.filter((q) => q.taskId === task.id && q.kind === 'permission');
  const approvalsDenied = Math.max(f.denials, permissions.filter((q) => q.decision === 'deny').length);
  const approvalsAsked = Math.max(permissions.length, approvalsDenied);
  const started = ms(task.startedAt);
  const completed = ms(task.completedAt);
  const o: Omit<TaskOutcome, 'frictionScore'> = {
    taskId: task.id,
    key: task.key,
    projectId: task.projectId,
    employeeId: task.assigneeId,
    kind: task.kind,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    firstPass: task.status === 'DONE' && f.failedVerifications === 0 && f.reviewRejections === 0,
    verified: task.evidence?.verification?.provenance === 'measured' && task.evidence.verification.passed === true && task.evidence.verification.kind !== 'syntax',
    failedVerifications: f.failedVerifications,
    reviewRejections: f.reviewRejections,
    mergeConflicts: f.mergeConflicts,
    blockers: f.blockers,
    questions: f.questions,
    approvalsAsked,
    approvalsDenied,
    nudges: task.nudges ?? 0,
    sentBack: task.attempts ?? 0,
    cycleMs: Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : null,
    tokens: tokensOf(task),
  };
  return { ...o, frictionScore: frictionScore(o) };
}

/** The friction counts as one number (weights: `FRICTION_WEIGHTS`). 0 is a clean run. */
export function frictionScore(o: Pick<TaskOutcome, keyof typeof FRICTION_WEIGHTS>): number {
  let score = 0;
  for (const k of Object.keys(FRICTION_WEIGHTS) as Array<keyof typeof FRICTION_WEIGHTS>) score += FRICTION_WEIGHTS[k] * o[k];
  return score;
}

/**
 * The tasks outcomes are counted from: done through the office's own completion (the employee
 * reported, the office checked), by someone, and not a review. The same tasks `performance()` counts.
 */
export function measurable(task: Task): boolean {
  return task.status === 'DONE' && !!task.completedAt && !!task.assigneeId && task.kind !== 'review' && !!task.evidence?.summary;
}

const byCompletion = (a: TaskOutcome, b: TaskOutcome): number => ms(a.completedAt) - ms(b.completedAt) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);

// ─────────────────────────────── trends ───────────────────────────────

export function statsOf(list: readonly TaskOutcome[]): OutcomeStats {
  const n = list.length;
  const firstPass = list.filter((o) => o.firstPass).length;
  const per = (f: (o: TaskOutcome) => number): number | null => (n ? r3(sum(list.map(f)) / n) : null);
  const cycle = median(list.map((o) => o.cycleMs).filter((x): x is number => x !== null));
  return { tasks: n, firstPass, firstPassRate: n ? r3(firstPass / n) : null, meanFriction: per((o) => o.frictionScore), questionsPerTask: per((o) => o.questions), approvalsPerTask: per((o) => o.approvalsAsked), medianCycleMs: cycle === null ? null : Math.round(cycle) };
}

/** The Monday (UTC) of the week a moment falls in. */
function weekStart(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
}

export interface OutcomeNames {
  project: (id: string) => string;
  employee: (id: string) => string;
}

/** Trends in a shape a table or a simple chart can show as it is. Weeks are by the day a task was finished. */
export function trendsOf(outcomes: readonly TaskOutcome[], names: OutcomeNames, now = Date.now()): OutcomeTrends {
  const sorted = [...outcomes].sort(byCompletion);
  const group = (key: (o: TaskOutcome) => string | null, label: (k: string) => string): OutcomeTrendRow[] => {
    const groups = new Map<string, TaskOutcome[]>();
    for (const o of sorted) {
      const k = key(o);
      if (k === null) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(o);
    }
    return [...groups].map(([k, list]) => ({ key: k, label: label(k), ...statsOf(list) })).sort((a, b) => b.tasks - a.tasks || a.label.localeCompare(b.label) || (a.key < b.key ? -1 : 1));
  };
  const byWeek: OutcomeTrendRow[] = [];
  if (sorted.length) {
    const last = weekStart(Math.max(now, ms(sorted[sorted.length - 1]!.completedAt)));
    const first = Math.max(weekStart(ms(sorted[0]!.completedAt)), last - (OUTCOME_RULES.weeks - 1) * 7 * DAY);
    const weeks = new Map<number, TaskOutcome[]>();
    for (let w = first; w <= last; w += 7 * DAY) weeks.set(w, []);
    for (const o of sorted) weeks.get(weekStart(ms(o.completedAt)))?.push(o);
    for (const [w, list] of weeks) {
      const day = new Date(w).toISOString().slice(0, 10);
      byWeek.push({ key: day, label: `Week of ${day}`, ...statsOf(list) });
    }
  }
  const W = OUTCOME_RULES.window;
  return {
    overall: statsOf(sorted),
    recent: { window: W, last: statsOf(sorted.slice(-W)), previous: statsOf(sorted.slice(-2 * W, -W)) },
    byWeek,
    byProject: group((o) => o.projectId, names.project),
    byEmployee: group((o) => o.employeeId, names.employee),
    byKind: group((o) => o.kind, (k) => k),
  };
}

// ───────────────────────── comparing two groups ─────────────────────────

/**
 * Compare a measure between two groups of tasks, like with like.
 *
 * Tasks are only compared within the same project, kind and employee. Each such cell that has tasks
 * on both sides gives a difference; the differences are averaged with side A's share of tasks in each
 * cell as the weight — so B's figure is "what B's tasks did, for the mix of work A had". Cells with
 * tasks on one side only are left out (nothing to compare them with).
 *
 * The standard error: for a yes/no measure, from each cell's pooled proportion with one success and
 * one failure added (so a cell where everything passed does not claim certainty); for a count,
 * from the spread of values around their own cell-and-side mean. z = difference / standard error.
 */
export function compare(a: readonly TaskOutcome[], b: readonly TaskOutcome[], value: (o: TaskOutcome) => number, binary: boolean): OutcomeComparison {
  const cells = new Map<string, { a: number[]; b: number[] }>();
  const cell = (o: TaskOutcome) => {
    const k = `${o.projectId}\u0000${o.kind}\u0000${o.employeeId ?? ''}`;
    if (!cells.has(k)) cells.set(k, { a: [], b: [] });
    return cells.get(k)!;
  };
  for (const o of a) cell(o).a.push(value(o));
  for (const o of b) cell(o).b.push(value(o));
  const matched = [...cells].filter(([, c]) => c.a.length && c.b.length).sort(([x], [y]) => (x < y ? -1 : 1)).map(([, c]) => c);
  const tasksA = sum(matched.map((c) => c.a.length));
  const tasksB = sum(matched.map((c) => c.b.length));
  if (!tasksA) return { tasksA: 0, tasksB: 0, a: null, b: null, diff: null, se: null, z: null };
  let meanA = 0;
  let meanB = 0;
  let variance = 0;
  let squares = 0;
  let freedom = 0;
  for (const c of matched) {
    const w = c.a.length / tasksA;
    const ma = avg(c.a)!;
    const mb = avg(c.b)!;
    meanA += w * ma;
    meanB += w * mb;
    const spread = w * w * (1 / c.a.length + 1 / c.b.length);
    if (binary) {
      const p = (sum(c.a) + sum(c.b) + 1) / (c.a.length + c.b.length + 2);
      variance += spread * p * (1 - p);
    } else {
      squares += sum(c.a.map((x) => (x - ma) ** 2)) + sum(c.b.map((x) => (x - mb) ** 2));
      freedom += c.a.length + c.b.length - 2;
      variance += spread;
    }
  }
  if (!binary) variance = freedom > 0 ? variance * (squares / freedom) : NaN;
  const diff = meanA - meanB;
  const se = Number.isFinite(variance) ? Math.sqrt(variance) : null;
  const z = se === null ? null : se < EPS ? (Math.abs(diff) < EPS ? 0 : Math.sign(diff) * Z_CAP) : Math.max(-Z_CAP, Math.min(Z_CAP, diff / se));
  return { tasksA, tasksB, a: r3(meanA), b: r3(meanB), diff: r3(diff), se: se === null ? null : r3(se), z: z === null ? null : r3(z) };
}

type Direction = 'higher' | 'lower';
type Judged = 'better' | 'worse' | 'no_benefit' | 'unclear';

/** The smallest change of a per-task count (or of the friction score) that counts, given where it started. */
const countEffect = (baseline: number | null): number => Math.max(OUTCOME_RULES.minCountDifference, OUTCOME_RULES.minCountShare * Math.abs(baseline ?? 0));

/**
 * Read a comparison: clearly better, clearly worse, a worthwhile benefit ruled out, or unclear.
 * "Clearly" is both things at once — the difference is at least the minimum that matters, and it is
 * at least 1.645 standard errors from zero. "Ruled out" means the minimum that matters is still out
 * of reach from a little above what was measured (difference + 0.84 standard errors).
 */
function judge(c: OutcomeComparison, better: Direction, minEffect: number): Judged {
  if (c.diff === null || c.se === null || c.z === null) return 'unclear';
  const sign = better === 'higher' ? 1 : -1;
  const gain = sign * c.diff;
  const z = sign * c.z;
  if (gain >= minEffect - EPS && z >= OUTCOME_RULES.z) return 'better';
  if (gain <= -minEffect + EPS && z <= -OUTCOME_RULES.z) return 'worse';
  if (gain + OUTCOME_RULES.zNoBenefit * c.se < minEffect - EPS) return 'no_benefit';
  return 'unclear';
}

/** Could side A have been better than B by the minimum that matters at all? (Not if B already passes 95% first time.) */
function room(c: OutcomeComparison, better: Direction, minEffect: number, binary: boolean): boolean {
  if (c.b === null) return false;
  if (better === 'lower') return c.b >= minEffect - EPS;
  return binary ? c.b <= 1 - minEffect + EPS : true;
}

// ───────────────────────── did a lesson help? ─────────────────────────

const appliesTo = (l: Lesson, task: Task): boolean => (l.scope === 'employee' ? !!l.employeeId && l.employeeId === task.assigneeId : l.scope === 'project' ? !!l.projectId && l.projectId === task.projectId : true);

/** Does the task itself say which lessons it was given? (Written by the playbook, when it does.) */
const recordedLessons = (task: Task): string[] | null => {
  // `playbookLessonIds`: what the playbook put into this task's prompts (learning/playbook.ts). A lesson that was
  // later folded into another one is counted for the one that carries on.
  const ids = task.playbookLessonIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : null;
};

/**
 * The lessons a task was given. The one place that knows how: the task's own `playbookLessonIds` when it
 * has them; otherwise worked out from dates — every lesson in the task's scope (its employee's, its
 * project's, the company's) that existed when the task was first started and had not been retired
 * by then. The fallback cannot see the cap on lessons per prompt, a lesson that waited for approval,
 * or one that was retired and later re-activated.
 */
export function lessonsGivenTo(task: Task, lessons: readonly Lesson[]): string[] {
  const recorded = recordedLessons(task);
  if (recorded) return recorded;
  const started = ms(task.startedAt);
  if (!Number.isFinite(started)) return [];
  return lessons.filter((l) => l.status !== 'proposed' && appliesTo(l, task) && ms(l.createdAt) <= started && !(l.status === 'retired' && ms(l.outcomesRetired?.at ?? l.updatedAt) <= started)).map((l) => l.id);
}

export interface FinishedTask {
  task: Task;
  outcome: TaskOutcome;
}

const firstPassOf = (o: TaskOutcome): number => (o.firstPass ? 1 : 0);

/**
 * For each lesson that is or was in use: the finished tasks that were given it against comparable
 * ones that were not, and what that says. `finished` must be the measurable tasks; `allLessons` is
 * needed when `lessons` is only some of them (the fallback of `lessonsGivenTo` looks at all).
 *
 * Two measures: the first-pass rate (should rise) and the friction score (should fall).
 *   harmful      — first-pass clearly worse; or friction clearly worse and first-pass not clearly better.
 *   helping      — first-pass clearly better and friction not clearly worse; or friction clearly better.
 *   not_helping  — at least 20 comparable tasks were given it, and for every measure that had room to
 *                  improve, a worthwhile improvement is ruled out.
 *   no_effect_yet — everything else, with the reason.
 */
export function lessonOutcomes(lessons: readonly Lesson[], finished: readonly FinishedTask[], allLessons: readonly Lesson[] = lessons): LessonOutcome[] {
  const R = OUTCOME_RULES;
  const given = new Map<string, Set<string>>();
  for (const f of finished) given.set(f.task.id, new Set(lessonsGivenTo(f.task, allLessons)));
  const out: LessonOutcome[] = [];
  for (const lesson of lessons) {
    if (lesson.status === 'proposed') continue;
    // The tasks a lesson was learned from are why it exists — trouble by selection. Counting them as
    // "without it" would make any lesson look good, so they are on neither side.
    const learnedFrom = new Set((lesson.evidence ?? []).filter((e) => e.kind === 'task').map((e) => e.id));
    const pool = finished.filter((f) => appliesTo(lesson, f.task));
    const withIt = pool.filter((f) => given.get(f.task.id)!.has(lesson.id));
    const without = pool.filter((f) => !given.get(f.task.id)!.has(lesson.id) && !learnedFrom.has(f.task.id));
    const a = withIt.map((f) => f.outcome);
    const b = without.map((f) => f.outcome);
    const firstPass = compare(a, b, firstPassOf, true);
    const friction = compare(a, b, (o) => o.frictionScore, false);
    let verdict: OutcomeVerdict = 'no_effect_yet';
    let reason: OutcomeUndecided | null = null;
    let needed: LessonOutcome['needed'] = null;
    let decidedBy: 'firstPass' | 'friction' = 'firstPass';
    if (firstPass.tasksA < R.minTasksPerSide || firstPass.tasksB < R.minTasksPerSide) {
      reason = 'too_few';
      needed = { with: Math.max(0, R.minTasksPerSide - firstPass.tasksA), without: Math.max(0, R.minTasksPerSide - firstPass.tasksB) };
    } else {
      const frictionEffect = countEffect(friction.b);
      const fp = judge(firstPass, 'higher', R.minFirstPassDifference);
      const fr = judge(friction, 'lower', frictionEffect);
      const rooms = [room(firstPass, 'higher', R.minFirstPassDifference, true) ? fp : null, room(friction, 'lower', frictionEffect, false) ? fr : null].filter((x): x is Judged => x !== null);
      if (fp === 'worse') verdict = 'harmful';
      else if (fr === 'worse' && fp !== 'better') (verdict = 'harmful'), (decidedBy = 'friction');
      else if (fp === 'better' && fr !== 'worse') verdict = 'helping';
      else if (fr === 'better') (verdict = 'helping'), (decidedBy = 'friction');
      else if (fp === 'better') reason = 'mixed';
      else if (!rooms.length) reason = 'no_room';
      else if (firstPass.tasksA >= R.minTasksForNoBenefit && rooms.every((x) => x === 'no_benefit')) (verdict = 'not_helping'), (decidedBy = 'friction');
      else reason = 'unclear';
    }
    const o: LessonOutcome = {
      lessonId: lesson.id,
      text: truncate(lesson.text, 200),
      scope: lesson.scope,
      employeeId: lesson.employeeId,
      projectId: lesson.projectId,
      status: lesson.status,
      proven: lesson.proven === true,
      basis: withIt.length > 0 && withIt.every((f) => recordedLessons(f.task) !== null) ? 'recorded' : 'inferred',
      given: withIt.length,
      notGiven: without.length,
      firstPass,
      friction,
      verdict,
      reason,
      needed,
      line: '',
    };
    o.line = lessonLine(o, decidedBy);
    out.push(o);
  }
  return out;
}

function lessonLine(o: LessonOutcome, decidedBy: 'firstPass' | 'friction'): string {
  const head = `given to ${plural(o.given, 'task')}`;
  if (!o.given) return `not given to any finished task yet — not enough data: ${OUTCOME_RULES.minTasksPerSide} comparable tasks are needed with it and ${OUTCOME_RULES.minTasksPerSide} without`;
  if (o.reason === 'too_few') {
    return `${head} — not enough data: ${o.firstPass.tasksA} of them can be compared with ${plural(o.firstPass.tasksB, 'task')} without it (same project, kind and employee); ${OUTCOME_RULES.minTasksPerSide} are needed on each side`;
  }
  const fp = `${pct(o.firstPass.a)} first-pass, against ${pct(o.firstPass.b)} without`;
  const fr = `friction ${num(o.friction.a)} a task, against ${num(o.friction.b)} without`;
  const figures = decidedBy === 'friction' || o.verdict === 'no_effect_yet' ? `${fp}; ${fr}` : fp;
  const word =
    o.verdict === 'helping'
      ? 'helping'
      : o.verdict === 'harmful'
        ? 'harmful'
        : o.verdict === 'not_helping'
          ? 'not helping'
          : o.reason === 'mixed'
            ? 'no verdict yet: it passes first time more often, but with more friction'
            : o.reason === 'no_room'
              ? 'no verdict: comparable tasks already go well without it, so there is nothing to measure an improvement against'
              : 'no clear effect yet';
  return `${head}: ${figures} — ${word}`;
}

/**
 * May the office retire this lesson by itself on this verdict? Only a lesson the office learned
 * (never the owner's own words), only once (a lesson somebody re-activated is left alone for good),
 * and only past the thresholds: `harmful` with at least 12 comparable tasks given it; `not_helping`
 * (which already needs 20).
 */
export function retirable(lesson: Lesson, o: LessonOutcome): boolean {
  if (lesson.status !== 'active' || lesson.outcomesRetired) return false;
  if (lesson.source === 'owner' || lesson.source === 'owner_answer') return false;
  if (o.verdict === 'harmful') return o.firstPass.tasksA >= OUTCOME_RULES.minTasksToRetire && o.firstPass.tasksB >= OUTCOME_RULES.minTasksPerSide;
  return o.verdict === 'not_helping';
}

// ──────────────────── did an applied improvement help? ────────────────────

type MetricKey = 'firstPass' | 'verified' | 'approvalsAsked' | 'approvalsDenied' | 'failedVerifications' | 'reviewRejections' | 'mergeConflicts' | 'friction';

const METRICS: Record<MetricKey, { label: string; binary: boolean; value: (o: TaskOutcome) => number }> = {
  firstPass: { label: 'first-pass rate', binary: true, value: firstPassOf },
  verified: { label: 'share of tasks with a verification the office ran itself and that passed', binary: true, value: (o) => (o.verified ? 1 : 0) },
  approvalsAsked: { label: 'approvals asked per task', binary: false, value: (o) => o.approvalsAsked },
  approvalsDenied: { label: 'approvals denied per task', binary: false, value: (o) => o.approvalsDenied },
  failedVerifications: { label: 'failed verifications per task', binary: false, value: (o) => o.failedVerifications },
  reviewRejections: { label: 'review rejections per task', binary: false, value: (o) => o.reviewRejections },
  mergeConflicts: { label: 'merge conflicts per task', binary: false, value: (o) => o.mergeConflicts },
  friction: { label: 'friction per task', binary: false, value: (o) => o.frictionScore },
};

/**
 * What each kind of change is judged on, which way is better, and — for changes that let agents do
 * more unasked — a guard: the first-pass rate must not clearly fall.
 *
 * A review gate that was switched on is judged on what it catches (rejections per task, more is
 * better): before it there were no reviews, so "fewer rejections" could never be shown.
 * A kind this table does not know is judged on the friction score.
 */
function judgedOn(imp: Improvement): { key: MetricKey; label: string; better: Direction; guard: boolean } | null {
  const m = (key: MetricKey, better: Direction, guard = false, label = METRICS[key].label) => ({ key, label, better, guard });
  switch (imp.kind as string) {
    case 'allow_rule':
    case 'autonomy':
      return m('approvalsAsked', 'lower', true);
    case 'deny_rule':
      return m('approvalsDenied', 'lower');
    case 'review_policy':
      return imp.action.type === 'project.requireReview' && !imp.action.value ? m('reviewRejections', 'lower', true) : m('reviewRejections', 'higher', false, 'problems caught by review per task');
    case 'verify_command':
      return m('verified', 'higher');
    case 'verify_timeout':
      return m('failedVerifications', 'lower');
    case 'sequencing':
      return m('mergeConflicts', 'lower');
    case 'acceptance_criteria':
    case 'routing':
      return m('firstPass', 'higher');
    case 'revert_improvement':
      return null;
    default:
      return m('friction', 'lower');
  }
}

/** Whose tasks an applied change touches: the employee or project its action names, else the one the suggestion was about. */
export function improvementScope(imp: Improvement): { projectId: string | null; employeeId: string | null } {
  const a = imp.action as { projectId?: string; employeeId?: string };
  if (a.employeeId) return { projectId: null, employeeId: a.employeeId };
  if (a.projectId) return { projectId: a.projectId, employeeId: null };
  return imp.projectId ? { projectId: imp.projectId, employeeId: null } : { projectId: null, employeeId: imp.employeeId };
}

/**
 * The tasks on each side of an applied change: the last 20 finished before it, and the first 20
 * started after it. Tasks that were under way when it was applied belong to neither.
 */
export function improvementWindows(imp: Improvement, outcomes: readonly TaskOutcome[]): { before: TaskOutcome[]; after: TaskOutcome[] } {
  const at = ms(imp.decidedAt);
  const scope = improvementScope(imp);
  const mine = outcomes.filter((o) => (!scope.projectId || o.projectId === scope.projectId) && (!scope.employeeId || o.employeeId === scope.employeeId)).sort(byCompletion);
  return { before: mine.filter((o) => ms(o.completedAt) < at).slice(-OUTCOME_RULES.window), after: mine.filter((o) => ms(o.startedAt) >= at).slice(0, OUTCOME_RULES.window) };
}

/**
 * Before and after, for each applied improvement. `all` is searched for a `revert_improvement`
 * suggestion already raised about it.
 *   harmful      — the measure this kind is judged on is clearly worse, or the guard is.
 *   helping      — the measure is clearly better (and the guard did not fall).
 *   not_helping  — 20 tasks after it, there was room to improve, and a worthwhile improvement is ruled out.
 */
export function improvementOutcomes(improvements: readonly Improvement[], outcomes: readonly TaskOutcome[], all: readonly Improvement[] = improvements): ImprovementOutcome[] {
  const R = OUTCOME_RULES;
  const out: ImprovementOutcome[] = [];
  for (const imp of improvements) {
    const on = judgedOn(imp);
    if (imp.status !== 'applied' || !imp.decidedAt || !on) continue;
    const metric = METRICS[on.key];
    const { before, after } = improvementWindows(imp, outcomes);
    const comparison = compare(after, before, metric.value, metric.binary);
    const guard = on.guard ? compare(after, before, firstPassOf, true) : null;
    let verdict: OutcomeVerdict = 'no_effect_yet';
    let reason: OutcomeUndecided | null = null;
    let needed: ImprovementOutcome['needed'] = null;
    let guardFell = false;
    if (comparison.tasksA < R.minTasksPerSide || comparison.tasksB < R.minTasksPerSide) {
      reason = 'too_few';
      needed = { before: Math.max(0, R.minTasksPerSide - comparison.tasksB), after: Math.max(0, R.minTasksPerSide - comparison.tasksA) };
    } else {
      const effect = metric.binary ? R.minFirstPassDifference : countEffect(comparison.b);
      const main = judge(comparison, on.better, effect);
      guardFell = !!guard && judge(guard, 'higher', R.minFirstPassDifference) === 'worse';
      if (main === 'worse' || guardFell) verdict = 'harmful';
      else if (main === 'better') verdict = 'helping';
      else if (!room(comparison, on.better, effect, metric.binary)) reason = 'no_room';
      else if (main === 'no_benefit' && comparison.tasksA >= R.minTasksForNoBenefit) verdict = 'not_helping';
      else reason = 'unclear';
    }
    const scope = improvementScope(imp);
    const o: ImprovementOutcome = {
      improvementId: imp.id,
      kind: imp.kind,
      title: imp.title,
      decidedAt: imp.decidedAt,
      projectId: scope.projectId,
      employeeId: scope.employeeId,
      metric: { key: on.key, label: on.label, better: on.better, before: comparison.b, after: comparison.a },
      before: statsOf(before),
      after: statsOf(after),
      comparison,
      guard,
      verdict,
      reason,
      needed,
      line: '',
      revertProposalId: all.find((x) => x.outcomesRevertOf === imp.id)?.id ?? null,
    };
    o.line = improvementLine(o, metric.binary, guardFell);
    out.push(o);
  }
  return out;
}

function improvementLine(o: ImprovementOutcome, binary: boolean, guardFell: boolean): string {
  const show = binary ? pct : num;
  if (o.reason === 'too_few') {
    return `${o.metric.label} — not enough data: ${plural(o.comparison.tasksB, 'task')} before the change can be compared with ${o.comparison.tasksA} after it (same project, kind and employee); ${OUTCOME_RULES.minTasksPerSide} are needed on each side`;
  }
  const figures = `${o.metric.label}: ${show(o.metric.before)} before (${plural(o.comparison.tasksB, 'task')}), ${show(o.metric.after)} after (${plural(o.comparison.tasksA, 'task')})`;
  const fell = guardFell && o.guard ? `; first-pass rate fell from ${pct(o.guard.b)} to ${pct(o.guard.a)}` : '';
  const word = o.verdict === 'helping' ? 'helping' : o.verdict === 'harmful' ? 'harmful' : o.verdict === 'not_helping' ? 'not helping' : o.reason === 'no_room' ? 'no verdict: there was nothing to improve on before the change' : 'no clear effect yet';
  return `${figures}${fell} — ${word}`;
}

// ─────────────────────── the employee's record ───────────────────────

/**
 * Add to each row of `performance()` the same record with recent work counting more: every finished
 * task weighs 0.5^(age / 45 days). `firstPassRate` is the weighted rate; `routingRate` is that rate
 * with one pass and one fail added, so two tasks do not speak as loudly as twenty.
 */
export function withRecentRecord(rows: PerformanceStat[], outcomes: readonly TaskOutcome[], now = Date.now()): PerformanceStat[] {
  const acc = new Map<string, { weight: number; firstPass: number; friction: number; last: number }>();
  for (const o of outcomes) {
    const done = ms(o.completedAt);
    if (!o.employeeId || !Number.isFinite(done)) continue;
    const key = `${o.employeeId}:${o.kind}`;
    if (!acc.has(key)) acc.set(key, { weight: 0, firstPass: 0, friction: 0, last: 0 });
    const a = acc.get(key)!;
    const w = 0.5 ** (Math.max(0, now - done) / (OUTCOME_RULES.halfLifeDays * DAY));
    a.weight += w;
    a.firstPass += w * firstPassOf(o);
    a.friction += w * o.frictionScore;
    a.last = Math.max(a.last, done);
  }
  for (const row of rows) {
    const a = acc.get(`${row.employeeId}:${row.kind}`);
    if (!a || a.weight <= 0) continue;
    row.outcomes = { weight: r3(a.weight), firstPassRate: r3(a.firstPass / a.weight), routingRate: r3((a.firstPass + 1) / (a.weight + 2)), meanFriction: r3(a.friction / a.weight), lastCompletedAt: new Date(a.last).toISOString() };
  }
  return rows;
}

/**
 * What learned routing makes of a row: nothing until there are two finished tasks of this kind whose
 * weights add up to 1.5 (two recent ones, or more older ones); then (routingRate − 0.5) × 4, as before.
 */
export function routingEvidence(row: PerformanceStat | undefined, kind: TaskKind): { bonus: number; reason: string | null } {
  const rec = row?.outcomes;
  if (!row || !rec || row.completed < OUTCOME_RULES.routingMinTasks || rec.weight < OUTCOME_RULES.routingMinWeight) return { bonus: 0, reason: null };
  const raw = row.firstPass / row.completed;
  const lately = Math.abs(rec.firstPassRate - raw) >= 0.1 ? `, ${pct(rec.firstPassRate)} counting recent work more` : '';
  return { bonus: (rec.routingRate - 0.5) * 4, reason: `${row.firstPass}/${row.completed} ${kind} tasks passed first time${lately}` };
}

// ───────────────────────────── the report ─────────────────────────────

/** What of the office someone may see in the report. Null (no scope) is everything. Decided in `apps/server/src/access.ts`. */
export interface OutcomesScope {
  task: (task: Task) => boolean;
  employee: (id: string) => boolean;
  project: (id: string) => boolean;
}

export interface OutcomesInput {
  tasks: readonly Task[];
  questions: readonly Question[];
  lessons: readonly Lesson[];
  improvements: readonly Improvement[];
  names: OutcomeNames;
  scope?: OutcomesScope | null;
  now?: number;
}

const lessonVisible = (l: Lesson, s: OutcomesScope): boolean => (l.scope === 'employee' ? !!l.employeeId && s.employee(l.employeeId) : l.scope === 'project' ? !!l.projectId && s.project(l.projectId) : true);
const improvementVisible = (i: Improvement, s: OutcomesScope): boolean => {
  const a = improvementScope(i);
  return [i.projectId, a.projectId].every((id) => !id || s.project(id)) && [i.employeeId, a.employeeId].every((id) => !id || s.employee(id));
};

/**
 * The whole report from plain records — no engine needed. With a scope, everything is counted from
 * the tasks that person may see, and lessons and improvements about what they may not see are left out.
 */
export function outcomesReport(input: OutcomesInput): OutcomesReport {
  const now = input.now ?? Date.now();
  const scope = input.scope ?? null;
  const permissions = input.questions.filter((q) => q.kind === 'permission' && !!q.taskId);
  const finished: FinishedTask[] = input.tasks
    .filter((t) => measurable(t) && (!scope || scope.task(t)))
    .map((task) => ({ task, outcome: outcomeOf(task, permissions) }))
    .sort((a, b) => byCompletion(a.outcome, b.outcome));
  return assemble(finished, input.lessons, input.improvements, input.names, scope, now);
}

function assemble(finished: readonly FinishedTask[], lessons: readonly Lesson[], improvements: readonly Improvement[], names: OutcomeNames, scope: OutcomesScope | null, now: number, judged?: { lessons: LessonOutcome[]; improvements: ImprovementOutcome[] }): OutcomesReport {
  const R = OUTCOME_RULES;
  const outcomes = finished.map((f) => f.outcome);
  return {
    generatedAt: new Date(now).toISOString(),
    tasks: finished.length,
    thresholds: { minTasksPerSide: R.minTasksPerSide, minTasksToRetire: R.minTasksToRetire, minTasksForNoBenefit: R.minTasksForNoBenefit, minFirstPassDifference: R.minFirstPassDifference, confidence: R.confidence, confidenceNoBenefit: R.confidenceNoBenefit, window: R.window },
    trends: trendsOf(outcomes, names, now),
    lessons: judged?.lessons ?? lessonOutcomes(scope ? lessons.filter((l) => lessonVisible(l, scope)) : lessons, finished, lessons),
    improvements: judged?.improvements ?? improvementOutcomes(scope ? improvements.filter((i) => improvementVisible(i, scope)) : improvements, outcomes, improvements),
  };
}

// ───────────────────────── wired into the office ─────────────────────────

/**
 * The same, bound to an office. Kept cheap: a finished task's outcome is worked out once and kept
 * until the task's record changes, and the verdicts are kept until a task is finished or a lesson
 * or an improvement changes.
 */
export class Outcomes {
  private eng: Engine;
  private kept = new Map<string, { updatedAt: string; completedAt: string | null; counts: number; outcome: TaskOutcome }>();
  private memo: { signature: string; lessons: LessonOutcome[]; improvements: ImprovementOutcome[] } | null = null;

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  /** Every measurable finished task with its outcome, in the order the tasks are stored. */
  private collect(): FinishedTask[] {
    const out: FinishedTask[] = [];
    let permissions: Map<string, Question[]> | null = null;
    for (const task of this.core.tasks.all()) {
      if (!measurable(task)) continue;
      // What an outcome is read from, as cheaply comparable values: the record's own stamps and its counters.
      const f = task.friction;
      const counts = task.nudges + 7 * task.attempts + 61 * f.failedVerifications + 331 * f.reviewRejections + 1009 * f.mergeConflicts + 5003 * f.blockers + 20011 * f.questions + 100003 * f.denials;
      let kept = this.kept.get(task.id);
      if (!kept || kept.updatedAt !== task.updatedAt || kept.completedAt !== task.completedAt || kept.counts !== counts) {
        if (!permissions) {
          permissions = new Map();
          for (const q of this.core.questions.all()) {
            if (q.kind !== 'permission' || !q.taskId) continue;
            if (!permissions.has(q.taskId)) permissions.set(q.taskId, []);
            permissions.get(q.taskId)!.push(q);
          }
        }
        this.kept.set(task.id, (kept = { updatedAt: task.updatedAt, completedAt: task.completedAt, counts, outcome: outcomeOf(task, permissions.get(task.id) ?? []) }));
      }
      out.push({ task, outcome: kept.outcome });
    }
    // Deleted tasks leave their kept outcome behind; clear out once that is most of the map.
    if (this.kept.size > out.length * 2 + 64) {
      const live = new Set(out.map((f) => f.task.id));
      for (const id of this.kept.keys()) if (!live.has(id)) this.kept.delete(id);
    }
    return out;
  }

  /** Measurable finished tasks, oldest first. */
  finished(): FinishedTask[] {
    return this.collect().sort((a, b) => byCompletion(a.outcome, b.outcome));
  }

  /** The verdicts for the whole office, recomputed only when something they depend on changed. */
  private judged(finished: FinishedTask[]): { lessons: LessonOutcome[]; improvements: ImprovementOutcome[] } {
    const lessons = this.core.lessons.all();
    const improvements = this.core.improvements.all();
    const signature = [
      finished.length,
      finished.reduce((latest, f) => (f.task.updatedAt > latest ? f.task.updatedAt : latest), ''),
      finished.reduce((n, f) => n + f.outcome.frictionScore, 0),
      lessons.map((l) => `${l.id}:${l.status}:${l.updatedAt}:${l.proven === true}`).join(','),
      improvements.map((i) => `${i.id}:${i.status}:${i.decidedAt}`).join(','),
    ].join('|');
    if (this.memo?.signature !== signature) {
      this.memo = { signature, lessons: lessonOutcomes(lessons, finished), improvements: improvementOutcomes(improvements, finished.map((f) => f.outcome)) };
    }
    return this.memo;
  }

  private names(): OutcomeNames {
    return { project: (id) => this.core.projects.get(id)?.name ?? '(deleted project)', employee: (id) => this.core.employees.get(id)?.name ?? '(former employee)' };
  }

  /** GET /api/growth/outcomes. `scope` is what the person asking may see (null: everything). */
  report(scope: OutcomesScope | null = null, now = Date.now()): OutcomesReport {
    const all = this.finished();
    if (!scope) return assemble(all, this.core.lessons.all(), this.core.improvements.all(), this.names(), null, now, this.judged(all));
    return assemble(all.filter((f) => scope.task(f.task)), this.core.lessons.all(), this.core.improvements.all(), this.names(), scope, now);
  }

  /** `performance()` rows with the decayed record learned routing reads. */
  decorate(rows: PerformanceStat[], now = Date.now()): PerformanceStat[] {
    return withRecentRecord(rows, this.collect().map((f) => f.outcome), now);
  }

  /**
   * The periodic pass (part of the scheduled analysis): act on what the record says.
   *  - a lesson that is harmful, or not helping, past the thresholds → retired (setting `outcomesAutoRetire`);
   *  - a lesson that clearly helps → marked proven; one that stopped being so → unmarked;
   *  - an applied improvement that made things worse → a `revert_improvement` suggestion for the owner
   *    (reverting is not done here).
   * Each is recorded as an event that carries its numbers and how to undo it. Returns the new suggestions.
   */
  act(): Improvement[] {
    const si = this.core.settings.selfImprovement;
    if (!si.enabled) return [];
    const finished = this.finished();
    const { lessons, improvements } = this.judged(finished);
    const proposed: Improvement[] = [];
    for (const o of lessons) {
      const lesson = this.core.lessons.get(o.lessonId);
      if (!lesson || lesson.status !== 'active') continue;
      const numbers = { verdict: o.verdict, basis: o.basis, given: o.given, notGiven: o.notGiven, firstPass: o.firstPass, friction: o.friction };
      const bad = o.verdict === 'harmful' || o.verdict === 'not_helping';
      if (bad && si.outcomesAutoRetire === true && retirable(lesson, o)) {
        lesson.status = 'retired';
        lesson.proven = false;
        lesson.outcomesRetired = { at: nowIso(), verdict: o.verdict as 'harmful' | 'not_helping', why: o.line };
        lesson.updatedAt = nowIso();
        this.core.put('lesson', lesson);
        this.core.audit('orchestrator', 'learning.retired', lesson.id, { verdict: o.verdict, why: o.line });
        this.core.event({
          type: 'learning.retired',
          source: 'server',
          summary: `Orchestrator retired a lesson that ${o.verdict === 'harmful' ? 'was making things worse' : 'made no measurable difference'}: ${truncate(lesson.text, 100)}`,
          employeeId: lesson.employeeId,
          projectId: lesson.projectId,
          data: { auto: true, area: 'outcomes', what: `Retired lesson ${lesson.id}: "${truncate(lesson.text, 160)}"`, why: o.line, evidence: numbers, undo: { type: 'lesson.status', lessonId: lesson.id, status: 'active' }, lessonId: lesson.id },
        });
      } else if (bad && lesson.proven) {
        this.mark(lesson, false, o.line, numbers);
      } else if (o.verdict === 'helping' && !lesson.proven) {
        this.mark(lesson, true, o.line, numbers);
      }
    }
    for (const o of improvements) {
      if (o.verdict !== 'harmful' || o.revertProposalId) continue;
      const imp = this.core.improvements.get(o.improvementId);
      const proposal = imp && this.proposeRevert(imp, o, improvementWindows(imp, finished.map((f) => f.outcome)).after);
      if (proposal) proposed.push(proposal);
    }
    return proposed;
  }

  private mark(lesson: Lesson, proven: boolean, why: string, numbers: Record<string, unknown>): void {
    lesson.proven = proven;
    lesson.updatedAt = nowIso();
    this.core.put('lesson', lesson);
    this.core.event({
      type: proven ? 'learning.proven' : 'learning.unproven',
      source: 'server',
      summary: proven ? `A lesson is proven to help: ${truncate(lesson.text, 100)}` : `A lesson is no longer counted as proven: ${truncate(lesson.text, 100)}`,
      employeeId: lesson.employeeId,
      projectId: lesson.projectId,
      data: { auto: true, area: 'outcomes', what: `${proven ? 'Marked' : 'Unmarked'} lesson ${lesson.id} as proven: "${truncate(lesson.text, 160)}"`, why, evidence: numbers, undo: { type: 'lesson.proven', lessonId: lesson.id, proven: !proven }, lessonId: lesson.id, quiet: true },
    });
  }

  /** A suggestion like any other in Growth (the owner applies or dismisses it); it names the change it is about in `outcomesRevertOf`. */
  private proposeRevert(imp: Improvement, o: ImprovementOutcome, after: TaskOutcome[]): Improvement | null {
    const key = `revert:${imp.id}`;
    if (this.core.improvements.find((i) => i.dedupeKey === key)) return null;
    const evidence: EvidenceRef[] = after.slice(-8).map((t) => ({ kind: 'task' as const, id: t.taskId, note: `${t.key}: ${t.firstPass ? 'passed first time' : 'did not pass first time'}, friction ${num(t.frictionScore)}` }));
    const title = truncate(`Undo "${imp.title}"`, 140);
    const rationale = `Since this was applied on ${imp.decidedAt!.slice(0, 10)}, things went worse — ${o.line}. Tasks are compared like with like (same project, kind and employee); this is a before/after comparison, so something else that changed at the same time could also be the cause. Nothing has been undone: this is for you to decide.`;
    const proposal: Improvement = { id: newId().slice(0, 8), kind: 'revert_improvement', title, rationale, evidence, projectId: imp.projectId, employeeId: imp.employeeId, action: { type: 'advice' }, status: 'proposed', dedupeKey: key, createdAt: nowIso(), decidedAt: null, outcomesRevertOf: imp.id };
    this.core.put('improvement', proposal);
    this.core.event({
      type: 'improvement.proposed',
      source: 'server',
      summary: `Orchestrator suggests: ${title}`,
      projectId: proposal.projectId,
      employeeId: proposal.employeeId,
      data: { improvementId: proposal.id, kind: proposal.kind, auto: true, area: 'outcomes', what: `Suggested undoing improvement ${imp.id}`, why: o.line, evidence: { verdict: o.verdict, metric: o.metric, comparison: o.comparison, guard: o.guard }, undo: { type: 'improvement.dismiss', improvementId: proposal.id }, revertOf: imp.id },
    });
    this.eng.comms.notify({ kind: 'improvement', severity: 'warning', title: `Suggestion: ${title}`, body: rationale, projectId: proposal.projectId, employeeId: proposal.employeeId });
    return proposal;
  }
}
