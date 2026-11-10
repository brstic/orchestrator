import type { CompanyStats, Employee, Milestone, Task, XpEntry, XpReason } from '@orchestrator/contracts';
import { levelForXp, newId, nowIso } from '@orchestrator/contracts';

/**
 * Progression. Every XP entry points at a verified record (a task that passed
 * independent verification, an approved review…). Nothing here rewards
 * terminal output, token consumption or time spent, and a level never claims
 * the underlying model became more capable — it is a record of delivered work.
 */

const PRIORITY_MULTIPLIER: Record<Task['priority'], number> = { low: 0.75, normal: 1, high: 1.25, urgent: 1.5 };

export const XP_VALUES: Record<XpReason, number> = {
  task_completed: 100,
  tests_passed: 25,
  bug_fixed: 40,
  review_completed: 40,
  deliverable_accepted: 30,
  assist: 30,
};

function entry(employeeId: string, reason: XpReason, amount: number, evidenceRef: string, note: string): XpEntry {
  return { id: newId(), employeeId, amount: Math.round(amount), reason, evidenceRef, note, ts: nowIso() };
}

/**
 * XP for a task that reached DONE. Only called after Orchestrator's own
 * verification — an agent saying "done" is not enough.
 */
export function xpForCompletedTask(task: Task): XpEntry[] {
  if (!task.assigneeId || task.status !== 'DONE') return [];
  const out: XpEntry[] = [];
  const mult = PRIORITY_MULTIPLIER[task.priority] ?? 1;
  out.push(entry(task.assigneeId, 'task_completed', XP_VALUES.task_completed * mult, task.id, `Completed ${task.key}: ${task.title}`));
  const v = task.evidence.verification;
  if (v && v.provenance === 'measured' && v.passed === true) out.push(entry(task.assigneeId, 'tests_passed', XP_VALUES.tests_passed, task.id, `Verification passed for ${task.key} (${v.command})`));
  if (task.kind === 'bug') out.push(entry(task.assigneeId, 'bug_fixed', XP_VALUES.bug_fixed, task.id, `Fixed bug ${task.key}`));
  if (task.evidence.review?.verdict === 'approved') out.push(entry(task.assigneeId, 'deliverable_accepted', XP_VALUES.deliverable_accepted, task.id, `Deliverable for ${task.key} accepted in review`));
  return out;
}

export function xpForReview(reviewerId: string, task: Task): XpEntry {
  return entry(reviewerId, 'review_completed', XP_VALUES.review_completed, task.id, `Reviewed ${task.key}`);
}

export function xpForAssist(helperId: string, requestId: string, note: string): XpEntry {
  return entry(helperId, 'assist', XP_VALUES.assist, requestId, note);
}

const LEVEL_BADGES: Array<[number, string]> = [
  [2, 'Contributor'],
  [4, 'Senior'],
  [6, 'Staff'],
  [8, 'Principal'],
  [10, 'Distinguished'],
];

/** Apply an XP entry to an employee. Returns the new level if they levelled up. */
export function applyXp(employee: Employee, e: XpEntry): { levelUp: number | null; newBadges: string[] } {
  const before = employee.level;
  employee.xp += e.amount;
  employee.level = levelForXp(employee.xp);
  const newBadges: string[] = [];
  for (const [level, badge] of LEVEL_BADGES) {
    if (employee.level >= level && !employee.badges.includes(badge)) {
      employee.badges.push(badge);
      newBadges.push(badge);
    }
  }
  switch (e.reason) {
    case 'task_completed':
      employee.stats.tasksCompleted++;
      break;
    case 'tests_passed':
      employee.stats.testsPassed++;
      break;
    case 'bug_fixed':
      employee.stats.bugsFixed++;
      break;
    case 'review_completed':
      employee.stats.reviewsCompleted++;
      break;
    case 'deliverable_accepted':
      employee.stats.deliverablesAccepted++;
      break;
    case 'assist':
      employee.stats.assists++;
      break;
  }
  const statBadges: Array<[boolean, string]> = [
    [employee.stats.bugsFixed >= 5, 'Bug Hunter'],
    [employee.stats.reviewsCompleted >= 5, 'Trusted Reviewer'],
    [employee.stats.assists >= 5, 'Team Player'],
    [employee.stats.testsPassed >= 10, 'Green Builds'],
  ];
  for (const [earned, badge] of statBadges) {
    if (earned && !employee.badges.includes(badge)) {
      employee.badges.push(badge);
      newBadges.push(badge);
    }
  }
  return { levelUp: employee.level > before ? employee.level : null, newBadges };
}

interface MilestoneDef {
  key: string;
  title: string;
  description: string;
  unlocks: string | null;
  reached: (s: CompanyStats) => boolean;
}

/** Company milestones. `unlocks` names an office upgrade (see layout `requires`). */
export const MILESTONE_DEFS: MilestoneDef[] = [
  { key: 'first_task', title: 'First Delivery', description: 'The first task passed verification.', unlocks: null, reached: (s) => s.tasksCompleted >= 1 },
  { key: 'ten_tasks', title: 'Momentum', description: 'Ten verified tasks delivered.', unlocks: 'arcade', reached: (s) => s.tasksCompleted >= 10 },
  { key: 'fifty_tests', title: 'Green Wall', description: 'Fifty verification runs passed.', unlocks: 'neon_sign', reached: (s) => s.testsPassed >= 50 },
  { key: 'first_delivery', title: 'Shipped', description: 'A whole project was delivered.', unlocks: 'trophy_case', reached: (s) => s.projectsDelivered >= 1 },
  { key: 'team_room', title: 'Growing Team', description: 'Twenty-five verified tasks delivered — a team room opens.', unlocks: 'team_room', reached: (s) => s.tasksCompleted >= 25 },
  { key: 'bug_squashers', title: 'Bug Squashers', description: 'Ten confirmed bugs resolved.', unlocks: null, reached: (s) => s.bugsResolved >= 10 },
  { key: 'review_culture', title: 'Review Culture', description: 'Twenty reviews completed.', unlocks: null, reached: (s) => s.reviewsCompleted >= 20 },
  { key: 'first_release', title: 'Released', description: 'A release command (publish, release, tag or image push) succeeded for the first time.', unlocks: null, reached: (s) => s.releases >= 1 },
  { key: 'debt_paid', title: 'Debt Paid Down', description: 'Ten verified refactoring or chore tasks.', unlocks: null, reached: (s) => s.debtReduced >= 10 },
  { key: 'hundred_hours', title: 'A Hundred Hours', description: 'Workers spent a hundred hours on tasks that passed verification.', unlocks: null, reached: (s) => s.agentWorkMs >= 100 * 3600_000 },
  { key: 'steady_floor', title: 'Steady Floor', description: 'Fifty sessions started with at least 95% of them never lost.', unlocks: null, reached: (s) => s.sessionsStarted >= 50 && (s.infrastructureReliability ?? 0) >= 0.95 },
  { key: 'clean_merges', title: 'Clean Integration', description: 'Twenty merges into integration without conflicts being forced.', unlocks: null, reached: (s) => s.mergesSucceeded >= 20 },
];

export function initialMilestones(): Milestone[] {
  return MILESTONE_DEFS.map((d) => ({ key: d.key, title: d.title, description: d.description, unlocks: d.unlocks, unlockedAt: null }));
}

/** Returns milestones newly reached with the given stats (mutates `milestones`). */
export function evaluateMilestones(milestones: Milestone[], stats: CompanyStats): Milestone[] {
  const unlocked: Milestone[] = [];
  for (const def of MILESTONE_DEFS) {
    let m = milestones.find((x) => x.key === def.key);
    if (!m) {
      m = { key: def.key, title: def.title, description: def.description, unlocks: def.unlocks, unlockedAt: null };
      milestones.push(m);
    }
    if (!m.unlockedAt && def.reached(stats)) {
      m.unlockedAt = nowIso();
      unlocked.push(m);
    }
  }
  return unlocked;
}

/** Recomputes the figures that are ratios of the counters (mutates and returns `stats`). */
export function deriveCompanyStats(stats: CompanyStats): CompanyStats {
  stats.reviewCompletionRate = stats.reviewsRequested > 0 ? Math.min(1, stats.reviewsCompleted / stats.reviewsRequested) : null;
  stats.infrastructureReliability = stats.sessionsStarted > 0 ? Math.max(0, (stats.sessionsStarted - stats.sessionsLost) / stats.sessionsStarted) : null;
  return stats;
}

export function emptyCompanyStats(): CompanyStats {
  return {
    projectsDelivered: 0,
    tasksCompleted: 0,
    bugsResolved: 0,
    testsPassed: 0,
    verificationsRun: 0,
    reviewsCompleted: 0,
    reviewCompletionRate: null,
    mergesSucceeded: 0,
    mergeConflicts: 0,
    questionsAnswered: 0,
    reviewsRequested: 0,
    releases: 0,
    deployments: 0,
    deploymentsFailed: 0,
    debtReduced: 0,
    agentWorkMs: 0,
    sessionsStarted: 0,
    sessionsLost: 0,
    hostDisconnects: 0,
    infrastructureReliability: null,
  };
}
