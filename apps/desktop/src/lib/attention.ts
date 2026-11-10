import type { Notification, NotificationKind, Question } from '@orchestrator/contracts';

/** Notification kinds that mean someone is stuck until a person acts. */
export const NEEDS_KINDS = new Set<NotificationKind>(['blocked', 'review', 'merge_conflict', 'session_lost', 'host_disconnected', 'host_resources', 'security']);

/**
 * What needs you: open questions and approvals, and unresolved notifications of the kinds above.
 * One definition for the whole window — the number on the Inbox button, the Inbox's own heading and
 * its first tab all say the same thing.
 */
export function needsYou(questions: Record<string, Question>, notifications: Record<string, Notification>): { questions: Question[]; stuck: Notification[]; count: number } {
  const open = Object.values(questions)
    .filter((q) => q.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const stuck = Object.values(notifications)
    .filter((n) => !n.resolvedAt && NEEDS_KINDS.has(n.kind))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { questions: open, stuck, count: open.length + stuck.length };
}
