import type { Notification, NotificationKind, Question } from '@orchestrator/contracts';

/** Notification kinds that mean someone is stuck until a person acts — and what an employee wrote to this person (`message`). */
export const NEEDS_KINDS = new Set<NotificationKind>(['blocked', 'review', 'merge_conflict', 'session_lost', 'host_disconnected', 'host_resources', 'security', 'message', 'task_assigned']);

/**
 * What needs you: open questions and approvals, and unresolved notifications of the kinds above.
 * One definition for the whole window — the number on the Inbox button, the Inbox's own heading and
 * its first tab all say the same thing.
 */
export function needsYou(questions: Record<string, Question>, notifications: Record<string, Notification>, mine?: (x: Question | Notification) => boolean): { questions: Question[]; stuck: Notification[]; count: number } {
  // `mine`: only what waits for this person (the Inbox on "Mine"); absent: the whole office's.
  const keep = mine ?? (() => true);
  const open = Object.values(questions)
    // (One waiting for a project manager's answer first is not the boss's yet.)
    .filter((q) => q.status === 'open' && !q.managerId && keep(q))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const stuck = Object.values(notifications)
    .filter((n) => !n.resolvedAt && NEEDS_KINDS.has(n.kind) && keep(n))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { questions: open, stuck, count: open.length + stuck.length };
}
