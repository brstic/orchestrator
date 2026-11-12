import { useCallback, useState } from 'react';
import type { Employee, ReviewBy, Task, TaskComment, TaskStatus } from '@orchestrator/contracts';
import { reviewByOf } from '@orchestrator/contracts';
import { Avatar, Badge, clock, type Tone } from '@orchestrator/ui';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';

/** What the work panels share: how a task's status is named and coloured, small pieces that show a person or a task. */

export const TASK_STATUSES: TaskStatus[] = ['BACKLOG', 'READY', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'DONE'];

export const STATUS_META: Record<TaskStatus, { label: string; tone: Tone; color: string }> = {
  BACKLOG: { label: 'Backlog', tone: 'muted', color: 'var(--faint)' },
  READY: { label: 'Ready', tone: 'info', color: 'var(--accent)' },
  IN_PROGRESS: { label: 'In progress', tone: 'accent', color: 'var(--violet)' },
  REVIEW: { label: 'Review', tone: 'warn', color: 'var(--warn)' },
  BLOCKED: { label: 'Blocked', tone: 'bad', color: 'var(--bad)' },
  DONE: { label: 'Done', tone: 'good', color: 'var(--good)' },
};

/** `act` plus a busy flag, so buttons can be disabled while a call is in flight. */
export function useAction(): [boolean, <T>(fn: () => Promise<T>, ok?: string) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string) => {
    setBusy(true);
    const res = await act(fn, ok);
    setBusy(false);
    return res;
  }, []);
  return [busy, run];
}

export function activeEmployees(employees: Record<string, Employee>): Employee[] {
  return Object.values(employees)
    .filter((e) => !e.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Date and time of a record, compact. */
export function stamp(iso: string): string {
  return `${new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(iso)}`;
}

export function Person({ id, size = 22, fallback = 'unassigned' }: { id: string | null | undefined; size?: number; fallback?: string }) {
  const e = useOffice((s) => (id ? s.employees[id] : undefined));
  if (!e) return <span className="muted">{fallback}</span>;
  return (
    <span className="row" style={{ gap: 6, minWidth: 0 }}>
      <Avatar appearance={e.appearance} size={size} />
      <span className="truncate">{e.name}</span>
    </span>
  );
}

/** A task reference that opens the task. */
export function TaskChip({ id }: { id: string }) {
  const task = useOffice((s) => s.tasks[id]);
  if (!task) return <Badge tone="muted" title="This task is no longer on the board">removed task</Badge>;
  return (
    <button type="button" className="pw-chip" title={`${task.title} — ${STATUS_META[task.status].label}`} onClick={() => useOffice.getState().openPanel('task', id)}>
      <span className="dot" style={{ background: STATUS_META[task.status].color }} />
      <span className="mono">{task.key}</span>
      <span className="truncate">{task.title}</span>
    </button>
  );
}


// ───────────────────── what a ticket needs, in words ─────────────────────

/** Who reviews a ticket, as a person chooses it. */
export const REVIEW_CHOICES: Array<{ id: ReviewBy; label: string; hint: string }> = [
  { id: 'both', label: 'A colleague, then me', hint: 'A colleague looks first and sends it back if something is wrong; what they approve comes to you.' },
  { id: 'boss', label: 'Me', hint: 'It comes straight to you when it is handed in.' },
  { id: 'peer', label: 'A colleague', hint: 'A colleague approves it; it comes to you only when there is nobody to review.' },
  { id: 'none', label: 'No review', hint: 'Done as soon as its check passes.' },
];

/** The groups the list of tickets is in: by what a ticket needs next, not by a column somebody moved it to. */
export type Need = 'you' | 'working' | 'waiting' | 'next' | 'done';
export const NEEDS: Array<{ id: Need; label: string; empty: string }> = [
  { id: 'you', label: 'Needs you', empty: 'Nothing is waiting for you.' },
  { id: 'working', label: 'In progress', empty: 'Nobody is working on a ticket right now.' },
  { id: 'waiting', label: 'Waiting', empty: 'Nothing is waiting for a colleague or for its parts.' },
  { id: 'next', label: 'Up next', empty: 'No ticket is queued.' },
  { id: 'done', label: 'Done', empty: 'Nothing is finished yet.' },
];

export interface TicketNeed {
  group: Need;
  /** The status as a person reads it. */
  label: string;
  tone: Tone;
  color: string;
  /** One line: what is going on with it, or what it waits for. */
  line: string;
}

const first = (text: string, n = 110) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The question on a ticket that nobody has answered yet (the one it is parked on, else the latest). */
export function openQuestionOf(task: Task): TaskComment | undefined {
  const open = (task.comments ?? []).filter((c) => c.kind === 'question' && !c.answeredBy);
  const parked = task.waitingFor?.kind === 'answer' ? task.waitingFor.commentId : null;
  return open.find((c) => c.id === parked) ?? open[open.length - 1];
}

export function needOf(task: Task, employees: Record<string, Employee>, tasks: Record<string, Task>): TicketNeed {
  const name = (id: string | null | undefined) => (id && employees[id]?.name) || 'somebody';
  const who = name(task.assigneeId);
  const meta = STATUS_META[task.status];
  const base = { label: meta.label, tone: meta.tone, color: meta.color };
  const question = openQuestionOf(task);
  const forBoss = !!question && (question.mentions.length === 0 || question.mentions.some((m) => m.kind === 'boss'));
  switch (task.status) {
    case 'DONE':
      return { ...base, group: 'done', line: task.evidence.summary ? first(task.evidence.summary) : 'Finished.' };
    case 'REVIEW': {
      const stage = task.reviewStage ?? (task.reviewerId && !task.evidence.peerReview ? 'peer' : 'boss');
      if (stage === 'boss') return { ...base, label: 'Your review', group: 'you', line: task.evidence.peerReview ? `${name(task.evidence.peerReview.reviewerId)} approved it — now you` : `${name(task.authorId ?? task.assigneeId)} handed it in` };
      return { ...base, label: 'In review', group: 'waiting', line: `${name(task.reviewerId)} is reviewing it${reviewByOf(task) === 'both' ? ', then you' : ''}` };
    }
    case 'BLOCKED': {
      if (task.waitingFor?.kind === 'parts') {
        const parts = Object.values(tasks).filter((t) => t.parentId === task.id);
        return { ...base, label: 'Waiting', tone: 'neutral', color: 'var(--muted)', group: 'waiting', line: `Waiting for its parts — ${parts.filter((p) => p.status === 'DONE').length} of ${parts.length} done` };
      }
      if (question && !forBoss) return { ...base, label: 'Waiting', tone: 'neutral', color: 'var(--muted)', group: 'waiting', line: `Waiting for ${question.mentions.map((m) => (m.kind === 'employee' ? m.name : 'you')).join(', ')} to answer ${who}` };
      // Parked on a question to the boss: it only waits for the answer. A reported blocker is something that is wrong.
      if (question && task.waitingFor) return { ...base, label: 'Asks you', tone: 'warn', color: 'var(--warn)', group: 'you', line: `${who}: ${first(question.body)}` };
      return { ...base, group: 'you', line: first(task.blockedReason ?? 'Blocked.') };
    }
    case 'IN_PROGRESS':
      if (question && forBoss) return { ...base, label: 'Asks you', tone: 'warn', color: 'var(--warn)', group: 'you', line: `${who}: ${first(question.body)}` };
      return { ...base, group: 'working', line: task.progress.note ? first(task.progress.note) : `${who} is working on it` };
    case 'BACKLOG':
      if (!task.released) return { ...base, label: 'Proposed', tone: 'warn', color: 'var(--warn)', group: 'you', line: /^(owner|member:)/.test(task.createdBy) ? 'Not released yet — release it to start' : `Proposed by ${task.createdBy.replace(/^[a-z]+:/, '')} — release it to start` };
      return { ...base, label: 'Up next', group: 'next', line: 'Waits for what it depends on' };
    default:
      return { ...base, label: 'Up next', group: 'next', line: task.assigneeId ? `Next for ${who}` : `For whoever is free${task.roleHint ? ` (${task.roleHint})` : ''}` };
  }
}
