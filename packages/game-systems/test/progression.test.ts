import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Employee, Task } from '@orchestrator/contracts';
import { applyXp, emptyCompanyStats, evaluateMilestones, initialMilestones, xpForCompletedTask, xpForReview } from '../src/index.ts';

function task(over: Partial<Task>): Task {
  return {
    id: 't1', key: 'T-1', title: 'x', status: 'DONE', assigneeId: 'e1', priority: 'normal', kind: 'feature',
    evidence: { summary: 's', reportedTests: null, commits: [], filesChanged: [], diffStat: null, verification: null, review: null, merge: null },
    ...over,
  } as Task;
}

test('XP is only granted for verified, completed work', () => {
  assert.deepEqual(xpForCompletedTask(task({ status: 'IN_PROGRESS' })), [], 'unfinished work earns nothing');
  assert.deepEqual(xpForCompletedTask(task({ assigneeId: null })), []);
  const plain = xpForCompletedTask(task({}));
  assert.deepEqual(plain.map((x) => [x.reason, x.amount]), [['task_completed', 100]]);
  // Tests only count when Orchestrator measured them — an agent's claim is not enough.
  const reported = xpForCompletedTask(task({ evidence: { ...task({}).evidence, reportedTests: 'npm test passed', verification: { ts: '', command: null, exitCode: null, passed: null, outputTail: '', durationMs: null, provenance: 'unavailable' } } }));
  assert.ok(!reported.some((x) => x.reason === 'tests_passed'));
  const measured = xpForCompletedTask(task({ kind: 'bug', priority: 'urgent', evidence: { ...task({}).evidence, verification: { ts: '', command: 'npm test', exitCode: 0, passed: true, outputTail: '', durationMs: 1, provenance: 'measured' }, review: { reviewerId: 'r', verdict: 'approved', comments: '', ts: '', by: 'employee' } } }));
  assert.deepEqual(measured.map((x) => [x.reason, x.amount]), [['task_completed', 150], ['tests_passed', 25], ['bug_fixed', 40], ['deliverable_accepted', 30]]);
  assert.ok(measured.every((x) => x.evidenceRef === 't1'), 'every entry points at its evidence');
});

test('levels, badges and milestones follow from the ledger', () => {
  const e = { id: 'e1', xp: 0, level: 1, badges: [], stats: { tasksCompleted: 0, testsPassed: 0, bugsFixed: 0, reviewsCompleted: 0, assists: 0, deliverablesAccepted: 0 } } as unknown as Employee;
  let leveled: number | null = null;
  for (let i = 0; i < 2; i++) leveled = applyXp(e, xpForCompletedTask(task({}))[0]!).levelUp ?? leveled;
  assert.equal(e.xp, 200);
  assert.equal(e.level, 2);
  assert.equal(leveled, 2);
  assert.ok(e.badges.includes('Contributor'));
  assert.equal(e.stats.tasksCompleted, 2);
  for (let i = 0; i < 5; i++) applyXp(e, xpForReview('e1', task({})));
  assert.ok(e.badges.includes('Trusted Reviewer'));
  const milestones = initialMilestones();
  const stats = emptyCompanyStats();
  assert.deepEqual(evaluateMilestones(milestones, stats), []);
  stats.tasksCompleted = 10;
  assert.deepEqual(evaluateMilestones(milestones, stats).map((m) => m.key).sort(), ['first_task', 'ten_tasks']);
  assert.deepEqual(evaluateMilestones(milestones, stats), [], 'a milestone unlocks once');
  assert.equal(milestones.find((m) => m.key === 'ten_tasks')!.unlocks, 'arcade');
});
