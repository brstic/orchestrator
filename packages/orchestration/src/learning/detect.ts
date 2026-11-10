import type { Employee, EvidenceRef, Improvement, ImprovementAction, ImprovementKind, OrchestratorEvent, OwnerSettings, Project, Question, Task, TaskKind, TaskStatus } from '@orchestrator/contracts';
import { matchRole, nowIso, roleByKey, truncate } from '@orchestrator/contracts';
import { EngineError } from '../core.ts';
import type { Engine } from '../engine.ts';

/**
 * What the office notices about how it works, beyond approvals and policy (those are in improve.ts).
 *
 * Every detector here reads recorded history only — task records, questions, the event log, host
 * records. None of them delivers a prompt to anyone, so none of them costs Claude usage. Each one
 * returns proposals; `Improver.propose` turns a proposal into an `Improvement` the owner decides on
 * (or, with the autopilot dial, the office applies). A detector never acts by itself.
 *
 * Three rules hold for all of them:
 *  - a minimum of evidence (the constants in `DETECT`), never one incident;
 *  - only what happened in the last `DETECT.lookbackDays` days counts, so a proposal describes how
 *    the office works now;
 *  - a finding is not proposed again while an earlier one is undecided, nor for
 *    `DETECT.coolingOffDays` after it was decided, and after that only on new evidence (`mayPropose`).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Every threshold a detector uses. Documented in docs/learning/detect.md; change them here. */
export const DETECT = {
  /** Records older than this are not read. */
  lookbackDays: 30,
  /** After a proposal was dismissed (or applied), the same finding stays quiet this long. */
  coolingOffDays: 30,
  /** …and afterwards it needs at least this many records the earlier proposal did not cite. */
  freshEvidence: 2,

  // 1. task size
  /** A task is "large" from this many characters of description and acceptance criteria… */
  largeDescriptionChars: 1500,
  /** …or this many files changed. */
  largeFilesChanged: 15,
  /** A task "needed rework" from this many attempts (each failed verification or rejected review is one)… */
  reworkAttempts: 3,
  /** …or this many reviews that sent it back. */
  reworkReviewRejections: 2,
  /** Large tasks that needed rework before splitting is advised. */
  splitMinTasks: 3,
  /** A task is "tiny" when it was in progress at most this long and changed at most `tinyFiles` files, with no friction. */
  tinyMinutes: 10,
  tinyFiles: 2,
  /** Tiny tasks in a dependency chain with another tiny task before batching is advised… */
  batchMinTasks: 5,
  /** …and they must be at least this share of the project's completed code tasks. */
  batchMinShare: 0.6,

  // 2. dependencies
  /** Merge conflicts between tasks worked in parallel, in one folder, before a habit is advised or two tasks are linked. */
  conflictMinIncidents: 2,

  // 3. routing
  /** Completed tasks of one kind, per person, before their record is compared. */
  routingMinTasks: 3,
  /** At most this share passed first time: "repeatedly fails". */
  routingWeakRate: 1 / 3,
  /** At least this share passed first time: "delivers first-pass". */
  routingStrongRate: 0.8,
  /** How much an accepted preference weighs in the scheduler: more than any role or track-record score. */
  routingPreferenceBonus: 100,

  // 4. questions that should not be needed
  /** Times a question was asked again after it had been answered. */
  questionMinRepeats: 2,
  /** Two questions are "the same" when at least this share of their distinctive words is common to both. */
  questionSimilarity: 0.6,

  // 5. stalls
  /** Incidents with the same cause in one project before a stall is reported. */
  stallMinIncidents: 3,
  /** A ready task that waited at least this long counts, when the record shows why it need not have. */
  stallReadyMinutes: 60,
  /** A question or approval that waited at least this long for an answer. */
  stallAnswerMinutes: 30,
  /** A session that stopped mid-task and stayed down at least this long. */
  stallSessionMinutes: 30,
  /** A task in progress with no event at all from its employee for at least this long. */
  stallSilenceMinutes: 45,
  /** Released tasks of a paused project count once they have waited this long. */
  stallPausedHours: 24,
  /** "At the same hour": at least this share of the incidents began inside one window of `stallHourWindow` hours. */
  stallHourShare: 0.6,
  stallHourWindow: 4,

  // 6. verification quality
  /** Measured passes of a command, with no failure at all, before it can be called a check that proves nothing… */
  verifyMinPasses: 5,
  /** …and tasks it passed that review sent back or that were reopened. */
  verifyMinSentBack: 2,
  /** Failed verifications of a project before their errors are compared… */
  verifyEnvMinFailures: 3,
  /** …and the share of them that must show the same environment error, on at least two tasks. */
  verifyEnvShare: 0.8,

  // 7. machine load
  /** Separate times a machine ran out of memory or CPU and lost a session or timed out a verification. */
  loadMinWindows: 2,
  /** A loss this long before the warning (the warning needs sustained pressure) or after the recovery still counts. */
  loadSlackMinutes: 10,

  // 8. idle capacity
  /** Days without any event from an employee's sessions and without work assigned. */
  idleDays: 3,
  /** Unreleased backlog tasks of a kind they take, waiting at least a day. */
  idleMinTasks: 2,
} as const;

/** What a detector hands to `Improver.propose`. */
export interface Proposal {
  kind: ImprovementKind;
  key: string;
  title: string;
  rationale: string;
  evidence: EvidenceRef[];
  projectId?: string | null;
  employeeId?: string | null;
  action: ImprovementAction;
}

// ───────────────────────────── small helpers ─────────────────────────────

const at = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);
const iso = (ms: number): string => new Date(ms).toISOString();
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const list = (items: string[], max = 5): string => (items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`);
const taskRef = (t: Task, note?: string): EvidenceRef => ({ kind: 'task', id: t.id, note: note ?? `${t.key} ${t.title}` });
const eventRef = (e: OrchestratorEvent, note?: string): EvidenceRef => ({ kind: 'event', id: e.id, note: note ?? e.summary });
const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};
function duration(ms: number): string {
  if (ms >= 2 * DAY) return `${Math.round(ms / DAY)} days`;
  if (ms >= 2 * HOUR) return `${Math.round(ms / HOUR)} hours`;
  return `${Math.max(1, Math.round(ms / MIN))} minutes`;
}
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export interface Stretch {
  from: number;
  to: number;
  /** Still in this status at `now`. */
  open: boolean;
  /** The history note that started it. */
  note: string;
}

/** The stretches of time a task spent in one status, read from its own history. */
export function stretches(task: Task, status: TaskStatus, now: number): Stretch[] {
  const out: Stretch[] = [];
  let cur: Stretch | null = null;
  for (const h of task.history) {
    const t = at(h.ts);
    if (h.status === status) cur ??= { from: t, to: now, open: true, note: h.note };
    else if (cur) {
      out.push({ ...cur, to: t, open: false });
      cur = null;
    }
  }
  if (cur) out.push(task.status === status ? cur : { ...cur, to: at(task.updatedAt) || now, open: false });
  return out;
}

const overlap = (aFrom: number, aTo: number, bFrom: number, bTo: number): number => Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom));

function handlesKind(e: Employee, task: Task): boolean {
  if (task.roleHint) return (roleByKey(task.roleHint) ?? matchRole(task.roleHint))?.key === e.roleKey;
  return !!roleByKey(e.roleKey)?.handles.includes(task.kind);
}
/** The scheduler's own rule for who may be given a project's tasks: on it, lent to it, or on no project at all. */
const onProject = (e: Employee, projectId: string): boolean => e.projectId === projectId || e.projectId === null || !!e.alsoProjectIds?.includes(projectId);
const worker = (e: Employee): boolean => !e.archived && e.roleKey !== 'foreman';

/**
 * "At the same hour": the window of `DETECT.stallHourWindow` hours (server time) in which most of the
 * given moments fall, when that is at least `DETECT.stallHourShare` of them. Null when they are spread out.
 */
export function busiestHours(moments: number[]): { from: number; to: number; count: number } | null {
  if (moments.length < 3) return null;
  const hours = moments.map((m) => new Date(m).getHours());
  let best = { from: 0, count: 0 };
  for (let from = 0; from < 24; from++) {
    const count = hours.filter((h) => (h - from + 24) % 24 < DETECT.stallHourWindow).length;
    if (count > best.count) best = { from, count };
  }
  return best.count / moments.length >= DETECT.stallHourShare ? { from: best.from, to: (best.from + DETECT.stallHourWindow) % 24, count: best.count } : null;
}
const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;

// ─────────────────────── proposing once, and not nagging ───────────────────────

/**
 * May a finding be proposed, given the earlier proposals with the same key?
 * Not while one is undecided; not for `coolingOffDays` after the last one was decided (dismissed,
 * applied or undone); and after that only when the record has grown: at least `freshEvidence`
 * cited records that no earlier proposal cited.
 */
export function mayPropose(earlier: Improvement[], evidence: EvidenceRef[], now = Date.now()): boolean {
  if (!earlier.length) return true;
  if (earlier.some((i) => i.status === 'proposed')) return false;
  const decided = Math.max(...earlier.map((i) => at((i as { revertedAt?: string | null }).revertedAt) || at(i.decidedAt) || at(i.createdAt) || now));
  if (now - decided < DETECT.coolingOffDays * DAY) return false;
  const cited = new Set(earlier.flatMap((i) => i.evidence.map((e) => `${e.kind}:${e.id}`)));
  return evidence.filter((e) => !cited.has(`${e.kind}:${e.id}`)).length >= DETECT.freshEvidence;
}

// ───────────────────────────── 1. task size ─────────────────────────────

function isLarge(t: Task): boolean {
  return t.description.length + t.acceptance.length >= DETECT.largeDescriptionChars || t.evidence.filesChanged.length >= DETECT.largeFilesChanged;
}
function neededRework(t: Task): boolean {
  return t.attempts >= DETECT.reworkAttempts || t.friction.reviewRejections >= DETECT.reworkReviewRejections;
}
function workedMs(t: Task, now: number): number {
  return stretches(t, 'IN_PROGRESS', now).reduce((n, s) => n + (s.to - s.from), 0);
}

function taskSize(eng: Engine, now: number): Proposal[] {
  const out: Proposal[] = [];
  const since = now - DETECT.lookbackDays * DAY;
  for (const project of eng.core.projects.filter((p) => p.status !== 'archived')) {
    const tasks = eng.core.tasks.filter((t) => t.projectId === project.id && t.kind !== 'review' && at(t.updatedAt) >= since);

    // Large tasks that kept coming back → split them.
    const tried = tasks.filter((t) => t.status === 'DONE' || t.attempts > 0);
    const large = tried.filter(isLarge);
    const small = tried.filter((t) => !isLarge(t));
    const hit = large.filter(neededRework);
    const smallHit = small.filter(neededRework);
    // Only when size is what sets them apart: smaller tasks of the same project must have gone better.
    if (hit.length >= DETECT.splitMinTasks && (!small.length || hit.length / large.length > smallHit.length / small.length)) {
      out.push({
        kind: 'task_size',
        key: `task-size:split:${project.id}`,
        title: `Split large tasks in ${project.name}`,
        rationale:
          `${plural(hit.length, 'large task')} in ${project.name} needed ${DETECT.reworkAttempts} or more attempts, or ${DETECT.reworkReviewRejections} reviews that sent them back (${list(hit.map((t) => t.key))}). ` +
          `"Large" means a description of ${DETECT.largeDescriptionChars} characters or more, or ${DETECT.largeFilesChanged} or more files changed. ` +
          `That is ${hit.length} of ${large.length} large tasks, against ${smallHit.length} of ${small.length} smaller ones in the last ${DETECT.lookbackDays} days. ` +
          'Split such work into tasks that can each be verified on their own, so the employee has a smaller thing to get right each time.',
        evidence: hit.slice(-8).map((t) => taskRef(t, `${t.key} ${truncate(t.title, 60)}: ${plural(t.attempts, 'attempt')}, ${plural(t.friction.reviewRejections, 'review rejection')}, ${t.evidence.filesChanged.length} files, description of ${t.description.length + t.acceptance.length} characters`)),
        projectId: project.id,
        action: { type: 'advice' },
      });
    }

    // Tiny tasks handed over one after another → batch them.
    const done = tasks.filter((t) => t.status === 'DONE' && t.kind !== 'research' && t.kind !== 'planning' && at(t.completedAt) >= since);
    const tiny = done.filter((t) => {
      const f = t.friction;
      const ms = workedMs(t, now);
      return ms > 0 && ms <= DETECT.tinyMinutes * MIN && t.evidence.filesChanged.length <= DETECT.tinyFiles && f.failedVerifications + f.reviewRejections + f.mergeConflicts + f.blockers === 0;
    });
    const tinyIds = new Set(tiny.map((t) => t.id));
    const chained = tiny.filter((t) => t.dependsOn.some((d) => tinyIds.has(d)) || tiny.some((o) => o.dependsOn.includes(t.id)));
    if (chained.length >= DETECT.batchMinTasks && chained.length / done.length >= DETECT.batchMinShare) {
      out.push({
        kind: 'task_size',
        key: `task-size:batch:${project.id}`,
        title: `Hand over small steps in ${project.name} as one task`,
        rationale:
          `${chained.length} of the ${done.length} tasks completed in ${project.name} in the last ${DETECT.lookbackDays} days were tiny (in progress ${DETECT.tinyMinutes} minutes or less, at most ${plural(DETECT.tinyFiles, 'file')} changed, nothing went wrong) and waited for one another in a chain (${list(chained.map((t) => t.key))}). ` +
          'Each task costs its own prompt, verification run and merge. Steps this small that follow one another can be written as one task with the steps listed in its description.',
        evidence: chained.slice(-8).map((t) => taskRef(t, `${t.key} ${truncate(t.title, 60)}: in progress ${duration(workedMs(t, now))}, ${plural(t.evidence.filesChanged.length, 'file')}`)),
        projectId: project.id,
        action: { type: 'advice' },
      });
    }
  }
  return out;
}

// ──────────────────────────── 2. dependencies ────────────────────────────

const folderOf = (file: string): string => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.');
const folderName = (folder: string): string => (folder === '.' ? 'the top folder of the repository' : `${folder}/`);

/** Does `task` wait, directly or through other tasks, for the task `id`? */
function waitsFor(eng: Engine, task: Task, id: string, seen = new Set<string>()): boolean {
  if (task.dependsOn.includes(id)) return true;
  seen.add(task.id);
  return task.dependsOn.some((d) => {
    const next = eng.core.tasks.get(d);
    return !!next && !seen.has(next.id) && waitsFor(eng, next, id, seen);
  });
}

interface ConflictIncident {
  event: OrchestratorEvent;
  a: Task;
  b: Task;
  files: string[];
}

/** Merge conflicts where another employee's task, worked at the same time, changed the same files. */
function parallelConflicts(eng: Engine, project: Project, now: number): ConflictIncident[] {
  const out: ConflictIncident[] = [];
  const tasks = eng.core.tasks.filter((t) => t.projectId === project.id && t.kind !== 'review');
  for (const event of eng.core.store.queryEvents({ projectId: project.id, types: ['task.merge_conflict'], since: iso(now - DETECT.lookbackDays * DAY), limit: 200 })) {
    const a = eng.core.tasks.get(event.taskId);
    const files = (event.data.conflicts as string[] | undefined) ?? [];
    if (!a || !a.startedAt || !files.length) continue;
    let best: ConflictIncident | null = null;
    for (const b of tasks) {
      if (b.id === a.id || !b.startedAt || b.assigneeId === a.assigneeId) continue;
      const shared = files.filter((f) => b.evidence.filesChanged.includes(f));
      // Worked in parallel: B was started before A's merge was tried, and was not finished before A started.
      const parallel = overlap(at(a.startedAt), at(event.ts), at(b.startedAt), at(b.completedAt) || now) > 0;
      if (shared.length && parallel && (!best || shared.length > best.files.length)) best = { event, a, b, files: shared };
    }
    if (best) out.push(best);
  }
  return out;
}

function dependencies(eng: Engine, now: number): Proposal[] {
  const out: Proposal[] = [];
  for (const project of eng.core.projects.filter((p) => p.status !== 'archived')) {
    const incidents = parallelConflicts(eng, project, now);
    const byFolder = new Map<string, ConflictIncident[]>();
    for (const i of incidents) for (const folder of new Set(i.files.map(folderOf))) byFolder.set(folder, [...(byFolder.get(folder) ?? []), i]);
    for (const [folder, found] of byFolder) {
      if (found.length < DETECT.conflictMinIncidents) continue;
      const files = [...new Set(found.flatMap((i) => i.files.filter((f) => folderOf(f) === folder)))];
      const pairs = found.map((i) => `${i.a.key} with ${i.b.key}`);
      // One file colliding again and again is the "sequencing" finding in improve.ts; this one is about a folder.
      if (files.length >= 2) {
        out.push({
          kind: 'dependencies',
          key: `deps:area:${project.id}:${folder}`,
          title: `Make tasks that change ${folderName(folder)} wait for each other`,
          rationale:
            `${plural(found.length, 'merge')} in ${project.name} conflicted in ${folderName(folder)} (${list(files)}) while the tasks were being worked on at the same time by different employees: ${list([...new Set(pairs)])}. ` +
            'When you create or plan tasks that will change this folder, set "depends on" between them so each one starts from the previous result instead of in parallel.',
          evidence: found.slice(-8).map((i) => eventRef(i.event, `${i.a.key} could not be merged; ${i.b.key}, worked in parallel, changed the same files: ${list(i.files, 3)}`)),
          projectId: project.id,
          action: { type: 'advice' },
        });
      }
      // Two tasks that have not started yet and that continue the two lines of work that collided here.
      for (const i of found) {
        const open = (t: Task) => (t.status === 'BACKLOG' || t.status === 'READY') && !t.startedAt && t.kind !== 'review';
        const afterA = eng.core.tasks.filter((t) => t.projectId === project.id && open(t) && t.dependsOn.includes(i.a.id));
        const afterB = eng.core.tasks.filter((t) => t.projectId === project.id && open(t) && t.dependsOn.includes(i.b.id));
        for (const x of afterA) {
          for (const y of afterB) {
            if (x.id === y.id || waitsFor(eng, x, y.id) || waitsFor(eng, y, x.id)) continue;
            const [first, later] = x.createdAt <= y.createdAt ? [x, y] : [y, x];
            const key = `deps:link:${later.id}:${first.id}`;
            if (out.some((p) => p.key === key)) continue;
            out.push({
              kind: 'dependencies',
              key,
              title: `Make ${later.key} wait for ${first.key}`,
              rationale:
                `${x.key} "${truncate(x.title, 60)}" continues ${i.a.key}, and ${y.key} "${truncate(y.title, 60)}" continues ${i.b.key}. ${i.a.key} and ${i.b.key} were worked on in parallel and their merge conflicted in ${list(i.files, 3)}; ` +
                `${plural(found.length, 'merge')} conflicted in ${folderName(folder)} in the last ${DETECT.lookbackDays} days. Neither ${first.key} nor ${later.key} has started. ` +
                `If ${later.key} starts only when ${first.key} is done, it builds on that result instead of colliding with it.`,
              evidence: [...found.slice(-6).map((f) => eventRef(f.event)), taskRef(first), taskRef(later)],
              projectId: project.id,
              action: { type: 'task.dependsOn', taskId: later.id, dependsOnTaskId: first.id },
            });
          }
        }
      }
    }
  }
  return out;
}

// ────────────────────────────── 3. routing ──────────────────────────────

/**
 * The owner accepted "give this kind of task to X first" for a project: X wins the scheduler's choice
 * whenever X is free and suitable. It follows the same switch as learned routing.
 */
export function routingPreference(settings: OwnerSettings, project: Project | undefined, kind: TaskKind, employeeId: string): { bonus: number; reason: string | null } {
  const si = settings.selfImprovement;
  if (!si.enabled || !si.learnedRouting || project?.detectRouting?.[kind] !== employeeId) return { bonus: 0, reason: null };
  return { bonus: DETECT.routingPreferenceBonus, reason: `preferred for ${kind} tasks in ${project.name}, a suggestion you accepted` };
}

function routing(eng: Engine, now: number): Proposal[] {
  const si = eng.core.settings.selfImprovement;
  if (!si.learnedRouting) return [];
  const out: Proposal[] = [];
  const since = now - DETECT.lookbackDays * DAY;
  const clean = (t: Task) => t.friction.failedVerifications === 0 && t.friction.reviewRejections === 0;
  for (const project of eng.core.projects.filter((p) => p.status !== 'archived')) {
    const done = eng.core.tasks.filter((t) => t.projectId === project.id && t.status === 'DONE' && !!t.assigneeId && t.kind !== 'review' && !!t.evidence.summary && at(t.completedAt) >= since);
    for (const kind of new Set(done.map((t) => t.kind))) {
      const rows = new Map<string, Task[]>();
      for (const t of done.filter((x) => x.kind === kind)) rows.set(t.assigneeId!, [...(rows.get(t.assigneeId!) ?? []), t]);
      const rated = [...rows.entries()].filter(([, tasks]) => tasks.length >= DETECT.routingMinTasks).map(([id, tasks]) => ({ employee: eng.core.employees.get(id), tasks, rate: tasks.filter(clean).length / tasks.length }));
      const weak = rated.filter((r) => r.rate <= DETECT.routingWeakRate && !!r.employee).sort((a, b) => a.rate - b.rate)[0];
      const strong = rated.filter((r) => r.rate >= DETECT.routingStrongRate && !!r.employee && worker(r.employee) && onProject(r.employee, project.id)).sort((a, b) => b.rate - a.rate || b.tasks.length - a.tasks.length)[0];
      if (!weak || !strong || project.detectRouting?.[kind] === strong.employee!.id) continue;
      const [e, c] = [weak.employee!, strong.employee!];
      // The scheduler only chooses among people whose role takes this kind of task; for anyone else this stays advice.
      const applicable = !!roleByKey(c.roleKey)?.handles.includes(kind);
      const failed = weak.tasks.filter((t) => !clean(t));
      out.push({
        kind: 'routing',
        key: `routing:${project.id}:${kind}:${c.id}`,
        title: `Give ${kind} tasks in ${project.name} to ${c.name} first`,
        rationale:
          `${e.name} completed ${plural(weak.tasks.length, `${kind} task`)} in ${project.name} in the last ${DETECT.lookbackDays} days and ${weak.tasks.filter(clean).length} passed first time ` +
          `(${failed.reduce((n, t) => n + t.friction.failedVerifications, 0)} failed verifications, ${failed.reduce((n, t) => n + t.friction.reviewRejections, 0)} review rejections). ` +
          `${c.name} completed ${strong.tasks.length} and ${strong.tasks.filter(clean).length} passed first time. ` +
          (applicable
            ? `With this preference the scheduler gives a ${kind} task in ${project.name} to ${c.name} whenever ${c.name} is free; when not, the task goes to whoever else is suitable, so nothing waits. ${e.name} keeps every other kind of work.`
            : `${c.name}'s role (${c.title}) is not one the scheduler gives ${kind} tasks to by itself, so nothing can be switched on here: assign ${kind} tasks in ${project.name} to ${c.name} by hand, or change their role.`),
        evidence: [...failed.slice(-5).map((t) => taskRef(t, `${e.name}: ${t.key} ${truncate(t.title, 50)} — ${t.friction.failedVerifications} failed verifications, ${t.friction.reviewRejections} review rejections`)), ...strong.tasks.filter(clean).slice(-5).map((t) => taskRef(t, `${c.name}: ${t.key} ${truncate(t.title, 50)} — passed first time`))],
        projectId: project.id,
        employeeId: c.id,
        action: applicable ? { type: 'project.routing', projectId: project.id, kind, employeeId: c.id } : { type: 'advice' },
      });
    }
  }
  return out;
}

// ───────────────── 4. questions that should not be needed ─────────────────

const STOPWORDS = new Set('the and for are was were with that this from have has had not but you your our can could should would will shall may might into onto about what which when where who whom why how does did done its their there here than then them they any all use used using need needs want wants get got also just like one two per via yes'.split(' '));

/** The distinctive words of a sentence: lower case, three letters or more, without the commonest English words. */
export function distinctiveWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? []).map((w) => w.replace(/[.-]+$/, '')).filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

/** Shared distinctive words over all distinctive words (Jaccard). A measure of wording, not of meaning. */
export function questionSimilarity(a: string, b: string): number {
  const [x, y] = [distinctiveWords(a), distinctiveWords(b)];
  if (x.size < 3 || y.size < 3) return 0;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared);
}

function answerOf(q: Question): string {
  const raw = q.answers && Object.keys(q.answers).length ? Object.entries(q.answers).map(([k, v]) => `${k} → ${v}`).join('; ') : (q.answer ?? '');
  return oneLine(raw.replace(/@@[\s\S]*?@@/g, ''));
}

function missingContext(eng: Engine, now: number): Proposal[] {
  const out: Proposal[] = [];
  const since = now - DETECT.lookbackDays * DAY;
  for (const project of eng.core.projects.filter((p) => p.status !== 'archived')) {
    const asked = eng.core.questions.filter((q) => q.projectId === project.id && (q.kind === 'question' || q.kind === 'decision')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const clusters: Array<{ source: Question; repeats: Question[] }> = [];
    for (const q of asked) {
      const known = clusters.find((c) => at(c.source.answeredAt) < at(q.createdAt) && questionSimilarity(c.source.text, q.text) >= DETECT.questionSimilarity);
      if (known) known.repeats.push(q);
      else if (q.answeredAt && answerOf(q)) clusters.push({ source: q, repeats: [] });
    }
    for (const { source, repeats } of clusters) {
      const recent = repeats.filter((q) => at(q.createdAt) >= since);
      if (recent.length < DETECT.questionMinRepeats) continue;
      const answer = answerOf(source);
      const text = `Decided: "${truncate(oneLine(source.text), 200)}" — ${truncate(answer, 240)}`;
      // Already in the notes (this very line, or the answer in the owner's own words): nothing to add.
      if (project.docs.includes(text) || (answer.length >= 12 && project.docs.toLowerCase().includes(answer.toLowerCase()))) continue;
      const askers = [...new Set(repeats.map((q) => eng.core.employees.get(q.employeeId)?.name).filter((n): n is string => !!n))];
      const lesson = eng.core.lessons.find((l) => l.status === 'active' && l.evidence.some((e) => e.kind === 'question' && e.id === source.id));
      const one = new Set(repeats.map((q) => q.employeeId)).size === 1 ? repeats[0]!.employeeId : null;
      out.push({
        kind: 'missing_context',
        key: `context:${project.id}:${source.id}`,
        title: `Write an answer that keeps being asked for into ${project.name}'s notes`,
        rationale:
          `"${truncate(oneLine(source.text), 160)}" was answered on ${source.answeredAt!.slice(0, 10)} ("${truncate(answer, 160)}") and has been asked again ${plural(repeats.length, 'time')} since${askers.length ? `, by ${list(askers)}` : ''}. ` +
          (lesson ? 'The answer is in team knowledge, which goes into task prompts, and it was still asked again. ' : 'The answer is not in the team knowledge that goes into task prompts. ') +
          `Adding it to the project's notes puts it where every employee reads the project's context. Questions are matched by their wording (at least ${Math.round(DETECT.questionSimilarity * 100)}% of the distinctive words in common), not by meaning — read the questions below before accepting.`,
        evidence: [{ kind: 'question', id: source.id, note: `First asked and answered: ${truncate(oneLine(source.text), 120)}` }, ...repeats.slice(-8).map((q) => ({ kind: 'question' as const, id: q.id, note: `Asked again${eng.core.employees.get(q.employeeId) ? ` by ${eng.core.employees.get(q.employeeId)!.name}` : ''} on ${q.createdAt.slice(0, 10)}: ${truncate(oneLine(q.text), 120)}` }))],
        projectId: project.id,
        employeeId: one,
        action: { type: 'project.notes.append', projectId: project.id, text },
      });
    }
  }
  return out;
}

// ────────────────────────────── 5. stalls ──────────────────────────────

type StallCause = 'project_paused' | 'machine_offline' | 'assignee_unavailable' | 'unassigned_no_auto' | 'nobody_qualified' | 'ready_unexplained' | 'waiting_approval' | 'waiting_answer' | 'session_down' | `quiet_after:${string}`;

interface Stall {
  projectId: string;
  cause: StallCause;
  from: number;
  ms: number;
  ref: EvidenceRef;
  /** A name the remedy needs: the machine, the employee, the kind of task. */
  subject?: string;
}

/** When each machine was disconnected, from the event log. A machine that is offline now is offline until `now`. */
function offlineWindows(eng: Engine, since: number, now: number): Map<string, Array<{ from: number; to: number }>> {
  const out = new Map<string, Array<{ from: number; to: number }>>();
  const open = new Map<string, number>();
  for (const e of eng.core.store.queryEvents({ types: ['worker.disconnected', 'worker.connected'], since: iso(since), limit: 2000 })) {
    if (!e.hostId) continue;
    if (e.type === 'worker.disconnected') open.set(e.hostId, open.get(e.hostId) ?? at(e.ts));
    else if (open.has(e.hostId)) {
      out.set(e.hostId, [...(out.get(e.hostId) ?? []), { from: open.get(e.hostId)!, to: at(e.ts) }]);
      open.delete(e.hostId);
    }
  }
  for (const [hostId, from] of open) if (eng.core.hosts.get(hostId)?.status !== 'online') out.set(hostId, [...(out.get(hostId) ?? []), { from, to: now }]);
  return out;
}

/** Events in plain words, for "work went quiet right after …". */
const STEP: Record<string, string> = {
  'task.started': 'the task was started',
  'task.verifying': 'verification was started',
  'task.verification_failed': 'a failed verification',
  'task.progress': 'a progress report',
  'agent.tool_started': 'a tool was started',
  'agent.tool_finished': 'a tool finished',
  'agent.tool_failed': 'a tool failed',
  'agent.turn_finished': 'the employee ended a turn without finishing the task',
  'agent.prompt_submitted': 'a prompt was delivered',
  'agent.message': 'a message',
  'agent.message_delivered': 'a message was delivered',
  'agent.question_answered': 'a question was answered',
  'agent.question_delivered': 'an answer was delivered',
  'agent.permission_decided': 'an approval was decided',
  'session.started': 'the session was started',
  'session.resumed': 'the session was resumed',
};

function stallIncidents(eng: Engine, now: number): Stall[] {
  const core = eng.core;
  const since = now - DETECT.lookbackDays * DAY;
  const out: Stall[] = [];
  const offline = offlineWindows(eng, since, now);
  const offlineFor = (hostId: string | null | undefined, from: number, to: number): number => (hostId ? (offline.get(hostId) ?? []).reduce((n, w) => n + overlap(from, to, w.from, w.to), 0) : 0);
  const projects = new Map(core.projects.filter((p) => p.status !== 'archived').map((p) => [p.id, p]));
  const tasks = core.tasks.filter((t) => projects.has(t.projectId) && t.kind !== 'review');
  const busy = new Map<string, Stretch[]>();
  for (const t of core.tasks.all()) if (t.assigneeId) busy.set(t.assigneeId, [...(busy.get(t.assigneeId) ?? []), ...stretches(t, 'IN_PROGRESS', now)]);
  const freeFor = (e: Employee, from: number, to: number): number => to - from - (busy.get(e.id) ?? []).reduce((n, s) => n + overlap(from, to, s.from, s.to), 0);

  // (a) Ready tasks that waited although the record shows they need not have.
  for (const t of tasks) {
    const project = projects.get(t.projectId)!;
    for (const s of stretches(t, 'READY', now)) {
      const ms = s.to - s.from;
      if (s.from < since || ms < DETECT.stallReadyMinutes * MIN) continue;
      const waited = `${t.key} ${truncate(t.title, 50)}: ready for ${duration(ms)}${s.open ? ' and still waiting' : ''}`;
      const add = (cause: StallCause, subject?: string) => out.push({ projectId: project.id, cause, from: s.from, ms, ref: taskRef(t, waited), subject });
      if (project.status === 'paused' || /^Project paused/.test(s.note)) {
        // Pausing is the owner's own decision; only work that is still waiting on it, for long, is worth a reminder.
        if (s.open && project.status === 'paused' && ms >= DETECT.stallPausedHours * HOUR) add('project_paused');
        continue;
      }
      const qualified = core.employees.filter((e) => worker(e) && onProject(e, project.id) && handlesKind(e, t));
      const assignee = core.employees.get(t.assigneeId);
      if (assignee) {
        const host = core.hosts.get(assignee.hostId);
        // A member's own computer goes when they do: that is not a fault.
        if (host && !host.memberId && offlineFor(host.id, s.from, s.to) >= DETECT.stallReadyMinutes * MIN) add('machine_offline', host.name);
        else if (s.open && !assignee.schedule.available && !assignee.archived) add('assignee_unavailable', assignee.name);
        continue; // otherwise they were simply busy: a queue, not a stall
      }
      const free = qualified.filter((e) => freeFor(e, s.from, s.to) >= DETECT.stallReadyMinutes * MIN);
      if (!qualified.length) add('nobody_qualified', t.roleHint ?? t.kind);
      else if (!free.length) continue;
      else if (!project.policy.autoAssign) add('unassigned_no_auto', free.map((e) => e.name).slice(0, 3).join(', '));
      else {
        const down = free.filter((e) => offlineFor(e.hostId, s.from, s.to) >= DETECT.stallReadyMinutes * MIN && !core.hosts.get(e.hostId)?.memberId);
        if (down.length === free.length) add('machine_offline', core.hosts.get(down[0]!.hostId)?.name);
        else add('ready_unexplained');
      }
    }
  }

  // (b) Questions and approvals that waited for an answer while the work stood still.
  const waits: Array<{ employeeId: string | null; from: number; to: number }> = [];
  for (const q of core.questions.filter((x) => !!x.projectId && projects.has(x.projectId) && x.kind !== 'merge_conflict' && x.kind !== 'trust_prompt' && at(x.createdAt) >= since)) {
    const until = q.answeredAt ? at(q.answeredAt) : q.status === 'open' ? now : NaN;
    const ms = until - at(q.createdAt);
    if (!(ms >= DETECT.stallAnswerMinutes * MIN)) continue;
    waits.push({ employeeId: q.employeeId, from: at(q.createdAt), to: until });
    const approval = q.kind === 'permission';
    out.push({ projectId: q.projectId!, cause: approval ? 'waiting_approval' : 'waiting_answer', from: at(q.createdAt), ms, ref: { kind: approval ? 'approval' : 'question', id: q.id, note: `Waited ${duration(ms)}${q.answeredAt ? '' : ' and still open'}: ${truncate(oneLine(q.text), 110)}` } });
  }

  // (c) Sessions that stopped in the middle of a task and stayed down.
  const sessions = core.store.queryEvents({ types: ['session.lost', 'session.started', 'session.resumed'], since: iso(since), limit: 2000 });
  const downs: Array<{ employeeId: string; from: number; to: number }> = [];
  for (const [i, e] of sessions.entries()) {
    if (e.type !== 'session.lost' || !e.employeeId) continue;
    const lost = at(e.ts);
    const task = tasks.find((t) => t.assigneeId === e.employeeId && stretches(t, 'IN_PROGRESS', now).some((s) => s.from <= lost && lost <= s.to));
    if (!task) continue;
    const back = sessions.slice(i + 1).find((x) => x.type !== 'session.lost' && x.employeeId === e.employeeId);
    const ms = (back ? at(back.ts) : now) - lost;
    if (ms < DETECT.stallSessionMinutes * MIN) continue;
    downs.push({ employeeId: e.employeeId, from: lost, to: lost + ms });
    out.push({ projectId: task.projectId, cause: 'session_down', from: lost, ms, ref: eventRef(e, `${e.summary}, during ${task.key}; ${back ? `back after ${duration(ms)}` : `still down after ${duration(ms)}`}`), subject: core.hosts.get(e.hostId)?.name });
  }

  // (d) Work in progress that went quiet with nothing on record to explain it, by what happened last.
  const eventsOf = new Map<string, OrchestratorEvent[]>();
  for (const t of tasks) {
    const who = core.employees.get(t.assigneeId);
    if (!who) continue;
    for (const s of stretches(t, 'IN_PROGRESS', now)) {
      if (s.to < since || s.to - s.from < DETECT.stallSilenceMinutes * MIN) continue;
      if (!eventsOf.has(who.id)) eventsOf.set(who.id, core.store.queryEvents({ employeeId: who.id, since: iso(since), limit: 2000 }));
      const mine = eventsOf.get(who.id)!.filter((e) => at(e.ts) >= s.from && at(e.ts) <= s.to);
      // Without hooks a session reports nothing at all; silence then says nothing about the work.
      if (mine.length < 3) continue;
      for (const [i, e] of mine.entries()) {
        const from = at(e.ts);
        const to = i + 1 < mine.length ? at(mine[i + 1]!.ts) : s.to;
        const ms = to - from;
        if (ms < DETECT.stallSilenceMinutes * MIN) continue;
        const explained = [...waits, ...downs].some((w) => w.employeeId === who.id && overlap(from, to, w.from, w.to) >= ms / 2) || offlineFor(who.hostId, from, to) >= ms / 2;
        if (explained) continue;
        out.push({ projectId: t.projectId, cause: `quiet_after:${e.type}`, from, ms, ref: taskRef(t, `${t.key} ${truncate(t.title, 50)}: nothing from ${who.name} for ${duration(ms)} after "${truncate(e.summary, 80)}"`) });
      }
    }
  }
  return out;
}

function stallText(cause: StallCause, found: Stall[], project: Project): { title: string; why: string; remedy: string } {
  const n = found.length;
  const typical = duration(median(found.map((s) => s.ms)));
  const subjects = [...new Set(found.map((s) => s.subject).filter((x): x is string => !!x))];
  const days = `in the last ${DETECT.lookbackDays} days`;
  switch (cause) {
    case 'project_paused':
      return { title: `${project.name} is paused with work waiting`, why: `${plural(n, 'released task')} of ${project.name} have been ready for ${typical} (typical) while the project is paused.`, remedy: 'Resume the project, or move the tasks back to the backlog if they are not wanted now.' };
    case 'machine_offline':
      return { title: `Work in ${project.name} waits while ${subjects[0] ?? 'its machine'} is disconnected`, why: `${n} times ${days} a ready task of ${project.name} waited (typically ${typical}) while ${list(subjects.map((s) => `"${s}"`)) || 'the machine it runs on'} was disconnected from the office.`, remedy: 'Keep the host agent running on that machine (it reconnects by itself when it is), or move these employees to a machine that stays on.' };
    case 'assignee_unavailable':
      return { title: `Tasks in ${project.name} are assigned to someone who is not available`, why: `${plural(n, 'ready task')} of ${project.name} wait (typically ${typical}) for ${list(subjects)}, who ${subjects.length === 1 ? 'is' : 'are'} marked as not available for work.`, remedy: 'Give the tasks to someone else, or switch "Available for work" back on in their profile.' };
    case 'unassigned_no_auto':
      return { title: `Ready tasks in ${project.name} wait for someone to assign them`, why: `${n} times ${days} a ready task of ${project.name} waited (typically ${typical}) with nobody assigned, while someone suitable had nothing in progress (${list(subjects, 3)}). The project does not assign work by itself.`, remedy: `Switch on "auto-assign" for ${project.name}, or let a foreman hand out ready work.` };
    case 'nobody_qualified':
      return { title: `Nobody on ${project.name} takes ${list(subjects, 3)} tasks`, why: `${n} times ${days} a ready task of ${project.name} waited (typically ${typical}) because no employee on the project has a role that is given that kind of task (${list(subjects)}).`, remedy: 'Hire or lend someone with a suitable role, or assign these tasks by hand.' };
    case 'ready_unexplained':
      return { title: `Ready work in ${project.name} keeps waiting at the same time of day`, why: `${n} times ${days} a ready task of ${project.name} waited (typically ${typical}) although someone suitable had nothing in progress and the project assigns by itself. The record does not show why.`, remedy: "Look at what is different then: employees' working hours, meetings, or a machine that is busy." };
    case 'waiting_approval':
      return { title: `Approvals in ${project.name} wait a long time for you`, why: `${plural(n, 'permission request')} in ${project.name} waited more than ${DETECT.stallAnswerMinutes} minutes for a decision ${days} (typically ${typical}). The employee's task stands still until you decide.`, remedy: "Give these employees working hours that match yours, so work is not started when nobody can approve. For routine commands, a suggestion to pre-approve them appears here once you have approved the same kind three times." };
    case 'waiting_answer':
      return { title: `Questions in ${project.name} wait a long time for an answer`, why: `${plural(n, 'question')} from employees in ${project.name} waited more than ${DETECT.stallAnswerMinutes} minutes for an answer ${days} (typically ${typical}). The task stands still until the answer comes.`, remedy: 'A foreman can answer employees\' questions first and pass on only what needs you (Settings → Foreman; each round uses Claude usage). Or give these employees working hours that match yours.' };
    case 'session_down':
      return { title: `Sessions in ${project.name} stop mid-task and stay down`, why: `${n} times ${days} a session stopped while its employee had a task of ${project.name} in progress and stayed down (typically ${typical})${subjects.length ? ` — on ${list(subjects.map((s) => `"${s}"`))}` : ''}.`, remedy: 'Start the employee again from their menu when it happens; the conversation resumes. If it is always the same machine, look at what stops sessions there (a restart, sleep, or running out of memory).' };
    default: {
      const type = cause.slice('quiet_after:'.length);
      const step = STEP[type] ?? `"${type}"`;
      return { title: `Work in ${project.name} goes quiet after the same step`, why: `${n} times ${days} a task of ${project.name} was in progress and nothing at all came from its employee for more than ${DETECT.stallSilenceMinutes} minutes (typically ${typical}), each time right after ${step}. No waiting question, stopped session or disconnected machine explains it.`, remedy: 'Look at what that step does in this project — for example a command that waits for input, or a long run with no output.' };
    }
  }
}

function stalls(eng: Engine, now: number): Proposal[] {
  const out: Proposal[] = [];
  const groups = new Map<string, Stall[]>();
  for (const s of stallIncidents(eng, now)) groups.set(`${s.projectId}:${s.cause}`, [...(groups.get(`${s.projectId}:${s.cause}`) ?? []), s]);
  for (const found of groups.values()) {
    const { projectId, cause } = found[0]!;
    const project = eng.core.projects.get(projectId);
    if (!project || found.length < DETECT.stallMinIncidents) continue;
    const hours = busiestHours(found.map((s) => s.from));
    // With no cause on record, only the time of day makes it a pattern.
    if (cause === 'ready_unexplained' && !hours) continue;
    const text = stallText(cause, found, project);
    out.push({
      kind: 'stall',
      key: `stall:${projectId}:${cause}`,
      title: text.title,
      rationale: `${text.why}${hours ? ` ${hours.count} of the ${found.length} began between ${hh(hours.from)} and ${hh(hours.to)} (the office's clock).` : ''} ${text.remedy}`,
      evidence: found.sort((a, b) => a.from - b.from).slice(-8).map((s) => s.ref),
      projectId,
      action: { type: 'advice' },
    });
  }
  return out;
}

// ──────────────────────── 6. verification quality ────────────────────────

/** Errors that are about the machine or the checkout, not about the work that was verified. */
const ENVIRONMENT_ERRORS: Array<{ name: string; re: RegExp }> = [
  { name: 'command not found', re: /.*(?:command not found|is not recognized as an internal or external command|: not found\b).*/i },
  { name: 'missing module', re: /.*(?:Cannot find module|MODULE_NOT_FOUND|ModuleNotFoundError|No module named|ERR_MODULE_NOT_FOUND).*/ },
  { name: 'missing file', re: /.*(?:ENOENT|No such file or directory).*/ },
  { name: 'port in use', re: /.*(?:EADDRINUSE|address already in use).*/i },
  { name: 'connection refused', re: /.*(?:ECONNREFUSED|Connection refused).*/ },
  { name: 'network', re: /.*(?:ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo|Could not resolve host|network is unreachable).*/i },
  { name: 'permission denied', re: /.*(?:EACCES|EPERM|Permission denied).*/ },
  { name: 'disk full', re: /.*(?:ENOSPC|No space left on device).*/ },
  { name: 'out of memory', re: /.*(?:ENOMEM|out of memory|heap out of memory|Killed\b).*/i },
  { name: 'docker not running', re: /.*(?:Cannot connect to the Docker daemon|docker daemon is not running).*/i },
  { name: 'dependencies not installed', re: /.*(?:node_modules missing|Run `?(?:npm|pnpm|yarn) install|ERR_PNPM_|packages? (?:is|are) not installed).*/i },
];

/** The environment error in a verification's output, if it shows one: which kind, and the line that says so. */
export function environmentError(output: string): { name: string; line: string } | null {
  for (const { name, re } of ENVIRONMENT_ERRORS) {
    const m = re.exec(output);
    if (m) return { name, line: truncate(oneLine(m[0]), 200) };
  }
  return null;
}

function verificationQuality(eng: Engine, now: number): Proposal[] {
  const out: Proposal[] = [];
  const since = now - DETECT.lookbackDays * DAY;
  for (const project of eng.core.projects.filter((p) => p.status !== 'archived')) {
    const tasks = eng.core.tasks.filter((t) => t.projectId === project.id && t.kind !== 'review' && at(t.updatedAt) >= since);
    const failures = eng.core.store.queryEvents({ projectId: project.id, types: ['task.verification_failed'], since: iso(since), limit: 400 });

    // (a) A command that has never failed, even on work that was then sent back: it proves nothing.
    const byCommand = new Map<string, Task[]>();
    for (const t of tasks) {
      const v = t.evidence.verification;
      if (v?.provenance === 'measured' && v.passed === true && v.command) byCommand.set(v.command, [...(byCommand.get(v.command) ?? []), t]);
    }
    for (const [command, passed] of byCommand) {
      const everFailed = failures.some((e) => e.data.command === command) || tasks.some((t) => t.friction.failedVerifications > 0 && (t.verifyCommand ?? project.verifyCommand) === command);
      if (everFailed || passed.length < DETECT.verifyMinPasses) continue;
      const reopened = (t: Task) => t.history.some((h, i) => h.status === 'DONE' && t.history.slice(i + 1).some((x) => x.status !== 'DONE'));
      const sentBack = passed.filter((t) => t.friction.reviewRejections > 0 || reopened(t));
      if (sentBack.length < DETECT.verifyMinSentBack) continue;
      out.push({
        kind: 'verify_quality',
        key: `verify-weak:${project.id}:${shortHash(command)}`,
        title: `"${truncate(command, 50)}" passes work that is then sent back in ${project.name}`,
        rationale:
          `"${command}" passed on ${plural(passed.length, 'task')} of ${project.name} in the last ${DETECT.lookbackDays} days and did not fail once — including on ${plural(sentBack.length, 'task')} that a review then sent back or that were reopened after being done (${list(sentBack.map((t) => t.key))}). ` +
          'A check that passes everything proves nothing about the work. Strengthen it with the tests or checks that would have caught what the reviews found.',
        evidence: sentBack.slice(-8).map((t) => taskRef(t, `${t.key} ${truncate(t.title, 50)}: passed "${truncate(command, 40)}", then ${t.friction.reviewRejections > 0 ? `sent back by review${t.evidence.review?.verdict === 'changes_requested' ? `: ${truncate(oneLine(t.evidence.review.comments), 90)}` : ` ${plural(t.friction.reviewRejections, 'time')}`}` : 'reopened after being done'}`)),
        projectId: project.id,
        action: { type: 'advice' },
      });
    }

    // (b) Failures that are almost always the same environment error: fix the environment, not the work.
    // (Timeouts are the "verify_timeout" finding in improve.ts.)
    const real = failures.filter((e) => e.data.timedOut !== true);
    if (real.length < DETECT.verifyEnvMinFailures) continue;
    const byError = new Map<string, Array<{ event: OrchestratorEvent; line: string }>>();
    for (const event of real) {
      const err = environmentError(String(event.data.outputTail ?? ''));
      if (err) byError.set(err.name, [...(byError.get(err.name) ?? []), { event, line: err.line }]);
    }
    for (const [name, same] of byError) {
      if (same.length < DETECT.verifyEnvMinFailures || same.length / real.length < DETECT.verifyEnvShare || new Set(same.map((s) => s.event.taskId)).size < 2) continue;
      out.push({
        kind: 'verify_quality',
        key: `verify-env:${project.id}:${name}`,
        title: `Verification in ${project.name} keeps failing on its environment (${name})`,
        rationale:
          `${same.length} of the ${real.length} failed verifications in ${project.name} in the last ${DETECT.lookbackDays} days show the same error, on ${new Set(same.map((s) => s.event.taskId)).size} different tasks: "${same[same.length - 1]!.line}". ` +
          'That is a problem with the machine or the checkout the command runs in, not with the work — yet each one is reported to the employee as their failure. Fix the environment (or make the verification command set it up) so the check measures the work.',
        evidence: same.slice(-8).map((s) => eventRef(s.event, `${s.event.summary}: ${s.line}`)),
        projectId: project.id,
        action: { type: 'advice' },
      });
    }
  }
  return out;
}

// ──────────────────────────── 7. machine load ────────────────────────────

function machineLoad(eng: Engine, now: number): Proposal[] {
  const out: Proposal[] = [];
  const since = now - DETECT.lookbackDays * DAY;
  const slack = DETECT.loadSlackMinutes * MIN;
  const warnings = eng.core.store.queryEvents({ types: ['host.resource_warning'], since: iso(since), limit: 1000 });
  const lost = eng.core.store.queryEvents({ types: ['session.lost'], since: iso(since), limit: 1000 });
  const timeouts = eng.core.store.queryEvents({ types: ['task.verification_failed'], since: iso(since), limit: 1000 }).filter((e) => e.data.timedOut === true);
  for (const host of eng.core.hosts.filter((h) => h.status !== 'revoked')) {
    const mine = warnings.filter((e) => e.hostId === host.id);
    const windows: Array<{ warning: OrchestratorEvent; from: number; to: number; casualties: OrchestratorEvent[] }> = [];
    for (const [i, w] of mine.entries()) {
      if (w.data.recovered === true) continue;
      const recovered = mine.slice(i + 1).find((x) => x.data.recovered === true);
      const from = at(w.ts) - slack;
      const to = (recovered ? at(recovered.ts) : Math.min(now, at(w.ts) + HOUR)) + slack;
      const inside = (e: OrchestratorEvent) => at(e.ts) >= from && at(e.ts) <= to;
      const casualties = [
        // A session of this machine that stopped while its employee had a task in progress…
        ...lost.filter((e) => e.hostId === host.id && inside(e) && eng.core.tasks.find((t) => t.assigneeId === e.employeeId && stretches(t, 'IN_PROGRESS', now).some((s) => s.from <= at(e.ts) && at(e.ts) <= s.to))),
        // …or a verification on it that ran out of time.
        ...timeouts.filter((e) => inside(e) && eng.core.employees.get(e.employeeId)?.hostId === host.id),
      ];
      if (casualties.length) windows.push({ warning: w, from, to, casualties });
    }
    if (windows.length < DETECT.loadMinWindows) continue;
    const sessions = windows.map((w) => Number(w.warning.data.sessions)).filter((n) => Number.isFinite(n) && n > 0);
    const limit = sessions.length ? Math.max(1, Math.min(...sessions) - 1) : null;
    const casualties = windows.flatMap((w) => w.casualties);
    const lostCount = casualties.filter((e) => e.type === 'session.lost').length;
    out.push({
      kind: 'machine_load',
      key: `load:${host.id}`,
      title: limit ? `Run at most ${plural(limit, 'session')} at once on "${host.name}"` : `Run fewer sessions at once on "${host.name}"`,
      rationale:
        `${windows.length} times in the last ${DETECT.lookbackDays} days "${host.name}" was measured out of memory or CPU and work was lost while it was: ${plural(lostCount, 'session')} stopped in the middle of a task and ${plural(casualties.length - lostCount, 'verification')} timed out. ` +
        (sessions.length ? `It was running ${list([...new Set(sessions)].sort((a, b) => a - b).map(String))} sessions when the warnings came, so ${limit} at once is what the record supports. ` : '') +
        'The office has no setting that limits sessions per machine, so nothing can be switched on here: keep fewer employees on this machine (move some to another one, or give them working hours that do not overlap), or give it more memory.',
      evidence: [...windows.slice(-4).map((w) => eventRef(w.warning)), ...casualties.slice(-6).map((e) => eventRef(e))],
      projectId: null,
      action: { type: 'advice' },
    });
  }
  return out;
}

// ──────────────────────────── 8. idle capacity ────────────────────────────

function idleCapacity(eng: Engine, now: number): Proposal[] {
  const out: Proposal[] = [];
  const core = eng.core;
  const idleSince = now - DETECT.idleDays * DAY;
  const idle = core.employees.filter((e) => {
    if (!worker(e) || !e.hostId || !e.schedule.available || at(e.createdAt) > idleSince) return false;
    // Nothing assigned that is theirs to do…
    if (core.tasks.find((t) => t.assigneeId === e.id && t.status !== 'DONE' && t.status !== 'BACKLOG')) return false;
    // …and not a single event from them for days.
    const last = core.store.queryEvents({ employeeId: e.id, limit: 1 })[0];
    return !last || at(last.ts) < idleSince;
  });
  if (!idle.length) return out;
  for (const project of core.projects.filter((p) => p.status === 'active')) {
    const waiting = core.tasks.filter((t) => t.projectId === project.id && t.status === 'BACKLOG' && !t.released && t.kind !== 'review' && at(t.createdAt) <= now - DAY);
    const people = idle.filter((e) => onProject(e, project.id) && waiting.some((t) => (!t.assigneeId || t.assigneeId === e.id) && handlesKind(e, t)));
    const theirs = waiting.filter((t) => people.some((e) => (!t.assigneeId || t.assigneeId === e.id) && handlesKind(e, t)));
    if (!people.length || theirs.length < DETECT.idleMinTasks) continue;
    out.push({
      kind: 'idle_capacity',
      key: `idle:${project.id}`,
      title: `${list(people.map((e) => e.name), 3)} ${people.length === 1 ? 'has' : 'have'} nothing to do while ${project.name}'s backlog waits`,
      rationale:
        `${list(people.map((e) => `${e.name} (${e.title})`))} ${people.length === 1 ? 'has' : 'have'} had no work and no activity for ${DETECT.idleDays} days or more, while ${plural(theirs.length, 'task')} of the kind they take wait in ${project.name}'s backlog without being released (${list(theirs.map((t) => t.key))}). ` +
        'The office never releases work by itself: release these tasks from Tasks if you want them done.',
      evidence: theirs.slice(-8).map((t) => taskRef(t, `${t.key} ${truncate(t.title, 60)} [${t.kind}]: in the backlog, not released, for ${duration(now - at(t.createdAt))}`)),
      projectId: project.id,
      employeeId: people.length === 1 ? people[0]!.id : null,
      action: { type: 'advice' },
    });
  }
  return out;
}

// ─────────────────────────────── running ───────────────────────────────

/** Every detector, by name. Each reads the record and returns what it supports; none changes anything. */
export const detectors: Record<string, (eng: Engine, now: number) => Proposal[]> = { taskSize, dependencies, routing, missingContext, stalls, verificationQuality, machineLoad, idleCapacity };

/** Run all detectors and hand what they found to `propose` (which keeps a finding from being proposed twice). */
export function runDetectors(eng: Engine, propose: (p: Proposal) => Improvement | null, now = Date.now()): Improvement[] {
  const out: Improvement[] = [];
  for (const [name, detect] of Object.entries(detectors)) {
    let found: Proposal[] = [];
    try {
      found = detect(eng, now);
    } catch (e) {
      // One detector tripping over an odd record must not silence the others.
      eng.core.log('warn', `learning: detector ${name} failed: ${(e as Error).message}`);
    }
    for (const p of found) {
      const imp = propose(p);
      if (imp) out.push(imp);
    }
  }
  return out;
}

// ───────────────────────── applying and reversing ─────────────────────────

type DetectAction = Extract<ImprovementAction, { type: 'task.dependsOn' | 'project.routing' | 'project.notes.append' }>;

/**
 * Perform one of this module's actions. Returns what was there before — `Improver.apply` keeps it on
 * the improvement as `previous`, which is what `revertDetectAction` needs.
 */
export function applyDetectAction(eng: Engine, a: DetectAction, actor = 'owner'): Record<string, unknown> {
  const core = eng.core;
  switch (a.type) {
    case 'task.dependsOn': {
      const task = core.tasks.require(a.taskId);
      const first = core.tasks.require(a.dependsOnTaskId);
      if (task.status !== 'BACKLOG' && task.status !== 'READY') throw new EngineError(`${task.key} is already ${task.status === 'DONE' ? 'done' : 'under way'}; it can no longer be made to wait for ${first.key}`, 409);
      if (first.id === task.id || waitsFor(eng, first, task.id)) throw new EngineError(`${first.key} already waits for ${task.key}: that would be a circle`, 409);
      const previous = { dependsOn: [...task.dependsOn], status: task.status };
      if (!task.dependsOn.includes(first.id)) task.dependsOn = [...task.dependsOn, first.id];
      // A ready task goes back to waiting; it stays released, so the scheduler makes it ready again by itself.
      if (task.status === 'READY' && first.status !== 'DONE') task.status = 'BACKLOG';
      task.history.push({ ts: nowIso(), status: task.status, note: `Waits for ${first.key}: their earlier tasks conflicted on the same files`, by: actor });
      task.updatedAt = nowIso();
      core.put('task', task);
      core.event({ type: 'task.updated', source: actor === 'owner' ? 'owner' : 'server', summary: `${task.key} now waits for ${first.key}`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, fields: ['dependsOn'], dependsOn: first.id } });
      eng.tasks.schedule();
      return previous;
    }
    case 'project.routing': {
      const project = core.projects.require(a.projectId);
      const employee = core.employees.require(a.employeeId);
      const previous = { employeeId: project.detectRouting?.[a.kind] ?? null };
      project.detectRouting = { ...(project.detectRouting ?? {}), [a.kind]: employee.id };
      core.put('project', project);
      core.audit(actor, 'project.updated', project.id, { fields: ['detectRouting'], kind: a.kind, employee: employee.name });
      core.event({ type: 'project.updated', source: actor === 'owner' ? 'owner' : 'server', summary: `${project.name}: ${a.kind} tasks go to ${employee.name} first`, projectId: project.id, employeeId: employee.id, data: { fields: ['detectRouting'], kind: a.kind } });
      eng.tasks.schedule();
      return previous;
    }
    case 'project.notes.append': {
      const project = core.projects.require(a.projectId);
      const previous = { docs: project.docs };
      if (!project.docs.split('\n').includes(a.text)) eng.tasks.updateProject(project.id, { docs: project.docs.trim() ? `${project.docs.replace(/\s+$/, '')}\n${a.text}` : a.text }, actor);
      return previous;
    }
  }
}

/**
 * Reverse one of this module's actions on an applied improvement, using its `previous`. Returns what
 * was undone, in plain words. It does not touch the improvement's status: whoever calls decides that.
 */
export function revertDetectAction(eng: Engine, imp: Improvement, actor = 'owner'): string {
  const core = eng.core;
  const a = imp.action;
  const previous = (imp.previous ?? {}) as Record<string, unknown>;
  switch (a.type) {
    case 'task.dependsOn': {
      const task = core.tasks.get(a.taskId);
      const first = core.tasks.get(a.dependsOnTaskId);
      if (!task) return 'The task no longer exists; there was nothing to undo.';
      // Only the dependency this suggestion added goes; one that was there before it stays.
      if (Array.isArray(previous.dependsOn) && previous.dependsOn.includes(a.dependsOnTaskId)) return `${task.key} already waited for ${first?.key ?? 'that task'} before the suggestion; nothing was changed.`;
      if (!task.dependsOn.includes(a.dependsOnTaskId)) return `${task.key} no longer waits for ${first?.key ?? 'that task'}; there was nothing to undo.`;
      task.dependsOn = task.dependsOn.filter((d) => d !== a.dependsOnTaskId);
      task.history.push({ ts: nowIso(), status: task.status, note: `No longer waits for ${first?.key ?? 'a task'} (suggestion undone)`, by: actor });
      task.updatedAt = nowIso();
      core.put('task', task);
      core.event({ type: 'task.updated', source: actor === 'owner' ? 'owner' : 'server', summary: `${task.key} no longer waits for ${first?.key ?? 'a task'}`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, fields: ['dependsOn'] } });
      eng.tasks.schedule();
      return `${task.key} no longer waits for ${first?.key ?? 'that task'}.`;
    }
    case 'project.routing': {
      const project = core.projects.get(a.projectId);
      if (!project) return 'The project no longer exists; there was nothing to undo.';
      if (project.detectRouting?.[a.kind] !== a.employeeId) return `The preference for ${a.kind} tasks in ${project.name} was changed since; it was left as it is.`;
      const next = { ...(project.detectRouting ?? {}) };
      if (typeof previous.employeeId === 'string' && core.employees.get(previous.employeeId)) next[a.kind] = previous.employeeId;
      else delete next[a.kind];
      project.detectRouting = next;
      core.put('project', project);
      core.audit(actor, 'project.updated', project.id, { fields: ['detectRouting'], kind: a.kind, undone: true });
      core.event({ type: 'project.updated', source: actor === 'owner' ? 'owner' : 'server', summary: `${project.name}: the preference for ${a.kind} tasks was taken back`, projectId: project.id, data: { fields: ['detectRouting'], kind: a.kind } });
      eng.tasks.schedule();
      return `${a.kind} tasks in ${project.name} are no longer given to ${core.employees.get(a.employeeId)?.name ?? 'that employee'} first.`;
    }
    case 'project.notes.append': {
      const project = core.projects.get(a.projectId);
      if (!project) return 'The project no longer exists; there was nothing to undo.';
      const lines = project.docs.split('\n');
      if (!lines.includes(a.text)) return `The line is no longer in ${project.name}'s notes; there was nothing to undo.`;
      // Take out the one line that was added; whatever was written in the notes since stays.
      eng.tasks.updateProject(project.id, { docs: lines.filter((l) => l !== a.text).join('\n') }, actor);
      return `The line was taken out of ${project.name}'s notes.`;
    }
    default:
      throw new EngineError('this suggestion was not made by the detectors in learning/detect.ts');
  }
}
