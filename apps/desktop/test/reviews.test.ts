import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewFound, reviewsOf } from '../src/lib/reviews.ts';

const t = (id: string, over: object = {}) => ({ id, key: id.toUpperCase(), kind: 'review', status: 'DONE', reviewOf: 't-201', createdAt: '2026-11-13T10:00:00Z', ...over }) as any;

test('the reviews of a task stand on the task: the open ones first, then the newest', () => {
  const tasks = {
    a: t('t-204', { createdAt: '2026-11-13T09:00:00Z' }),
    b: t('t-206', { status: 'BLOCKED', createdAt: '2026-11-13T10:00:00Z' }),
    c: t('t-208', { createdAt: '2026-11-13T11:00:00Z' }),
    other: t('t-207', { reviewOf: 't-999' }),
    plain: t('t-205', { kind: 'feature', reviewOf: null }),
  };
  assert.deepEqual(reviewsOf({ id: 't-201' }, tasks).map((r) => r.key), ['T-206', 'T-208', 'T-204']);
  assert.deepEqual(reviewsOf({ id: 't-000' }, tasks), []);
});

test('a review ticket is found by its key, also while review tickets are not shown', () => {
  const review = { key: 'T-206', kind: 'review' } as any;
  assert.deepEqual(['t-206', 'T-206', '#t-206', 'where is T-206'].map((n) => reviewFound(review, n)), [true, true, true, true]);
  // Not by a part of it (every "T-2…" would show), not by its words, and never a ticket of another kind.
  assert.deepEqual(['t-20', 't-2061', 'review', ''].map((n) => reviewFound(review, n)), [false, false, false, false]);
  assert.equal(reviewFound({ key: 'T-206', kind: 'feature' } as any, 't-206'), false);
});
