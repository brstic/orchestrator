import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth } from '../src/lib/check-health.ts';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const handed = (ts: string) => [{ ts, status: 'REVIEW', note: 'Verified; waiting for review', by: 'orchestrator' }];
const v = (kind: 'command' | 'syntax' | null, passed: boolean | null = true) =>
  kind ? { ts: '2026-11-22T10:00:00Z', command: kind === 'syntax' ? 'syntax check of the changed files' : 'npm test', exitCode: 0, passed, outputTail: '', durationMs: 1, provenance: 'measured', kind } : { ts: '2026-11-22T10:00:00Z', command: null, exitCode: null, passed: null, outputTail: '', durationMs: null, provenance: 'unavailable' };
const task = (id: string, over: any = {}) =>
  ({ id, key: id.toUpperCase(), title: id, kind: 'feature', status: 'DONE', history: handed('2026-11-22T09:00:00Z'), friction: { reviewRejections: 0 }, updatedAt: '2026-11-22T09:00:00Z', completedAt: null, reviewStage: null, reviewerId: null, ...over, evidence: { review: null, peerReview: null, verification: v(null), ...(over.evidence ?? {}) } }) as any;

test('how work was checked: what the office tested, what colleagues said they checked, how the owner approved', () => {
  const h = checkHealth(
    [
      task('t-1', { evidence: { verification: v('command'), review: { by: 'owner', verdict: 'approved', comments: '', reviewerId: null, ts: '' }, peerReview: { reviewerId: 'rita', comments: 'ok', ts: '', checked: 'Ran the tests on dev: 12 pass.' } } }),
      task('t-2', { friction: { reviewRejections: 1 }, evidence: { verification: v('syntax'), review: { by: 'owner', verdict: 'approved', comments: 'Good.', reviewerId: null, ts: '' }, peerReview: { reviewerId: 'rita', comments: 'ok', ts: '' } } }),
      task('t-3', { evidence: { review: { by: 'employee', verdict: 'approved', comments: 'fine', reviewerId: 'bo', ts: '', checked: 'Opened the page.' } } }),
      task('t-old', { history: handed('2026-10-01T09:00:00Z') }),
      task('t-rev', { kind: 'review' }),
      task('t-cancelled', { cancelled: { by: 'x', reason: 'y', ts: '' } }),
    ],
    NOW,
  );
  assert.deepEqual(
    { handedIn: h.handedIn, tested: h.tested, syntaxOnly: h.syntaxOnly, unchecked: h.unchecked, peerApprovals: h.peerApprovals, peerChecked: h.peerChecked, sentBack: h.sentBack, ownerApprovals: h.ownerApprovals, ownerSaid: h.ownerSaid },
    { handedIn: 3, tested: 1, syntaxOnly: 1, unchecked: 1, peerApprovals: 3, peerChecked: 2, sentBack: 1, ownerApprovals: 2, ownerSaid: 1 },
  );
});

test('what waits for an owner, oldest first — also long ago handed in', () => {
  const h = checkHealth(
    {
      a: task('t-176', { status: 'REVIEW', reviewStage: 'boss', history: handed('2026-11-18T13:04:00Z'), evidence: { peerReview: { reviewerId: 'r', comments: '', ts: '2026-11-18T13:05:00Z' } } }),
      b: task('t-400', { status: 'REVIEW', reviewStage: 'boss', history: handed('2026-11-23T08:00:00Z') }),
      c: task('t-401', { status: 'REVIEW', reviewStage: 'peer', reviewerId: 'r' }),
    },
    NOW,
  );
  assert.deepEqual(h.waiting.map((w) => [w.key, w.since]), [['T-176', '2026-11-18T13:05:00Z'], ['T-400', '2026-11-23T08:00:00Z']]);
});

test('what was decided without the owner, against what came to them', async () => {
  const { autonomy } = await import('../src/lib/check-health.ts');
  const byMia = { ts: '2026-11-22T10:00:00Z', status: 'DONE', note: "Review approved by Mia, the manager, in the boss's place", by: 'Mia' };
  const a = autonomy(
    [
      task('m1', { history: [byMia], release: { plan: 'x', approvedBy: "Mia (the manager, in the boss's place)" } }),
      task('m2', { history: [byMia] }),
      task('o1', { evidence: { review: { by: 'owner', verdict: 'approved', comments: '', reviewerId: null, ts: '2026-11-22T11:00:00Z' } } }),
      task('old', { history: [{ ...byMia, ts: '2026-10-01T10:00:00Z' }] }),
    ],
    [
      { id: 'q1', kind: 'decision', answeredAt: '2026-11-22T10:00:00Z', answeredBy: { kind: 'manager', id: 'm', name: 'Mia' } },
      { id: 'q2', kind: 'deployment', answeredAt: '2026-11-22T10:00:00Z', answeredBy: null },
      { id: 'q3', kind: 'permission', answeredAt: '2026-11-22T10:00:00Z', answeredBy: null },
    ] as any,
    NOW,
  );
  assert.deepEqual(a, { days: 7, reviewsByManagers: 2, reviewsByOwners: 1, releasesByManagers: 1, questionsByManagers: 1, questionsByOwners: 1 });
});
