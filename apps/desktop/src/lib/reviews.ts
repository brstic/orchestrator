import type { Task } from '@orchestrator/contracts';

/** How a review stands, in a word, beside the name of whoever has it. */
export const REVIEW_WORD: Record<string, string> = { DONE: 'done', IN_PROGRESS: 'reading', ASSIGNED: 'reading', BLOCKED: 'blocked', READY: 'waiting', BACKLOG: 'waiting', REVIEW: 'in review' };

type Reviewish = Pick<Task, 'id' | 'key' | 'kind' | 'status' | 'reviewOf' | 'createdAt'>;

/**
 * The reviews colleagues were asked for on a task: the ones still open first (those are what somebody may be stuck
 * on), then the finished ones, newest first. Shown on the task itself, so that a review is not something one only
 * ever meets in the Inbox.
 */
export function reviewsOf<T extends Reviewish>(task: Pick<Task, 'id'>, tasks: Record<string, T>): T[] {
  return Object.values(tasks)
    .filter((t) => t.kind === 'review' && t.reviewOf === task.id)
    .sort((a, b) => Number(a.status === 'DONE') - Number(b.status === 'DONE') || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * Is a review ticket shown in the task list although "Show review tasks" is off? When it is what was searched for:
 * the words name its key ("T-206"), whole. Somebody who was told about T-206 finds T-206.
 */
export function reviewFound(task: Pick<Task, 'key' | 'kind'>, needle: string): boolean {
  if (task.kind !== 'review') return false;
  const key = task.key.toLowerCase();
  return needle
    .toLowerCase()
    .split(/[\s,;]+/)
    .some((w) => w === key || w === `#${key}`);
}
