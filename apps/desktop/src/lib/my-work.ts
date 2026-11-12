import { ACTIVITY_LABEL, type Task } from '@orchestrator/contracts';

/**
 * The words of the My work window (docs/UI.md): how an employee is, in one word and one dot; the phrase under their
 * name; the window's one line about all of it; how a task stands. Nothing here touches the page.
 */

export type StateTone = 'calm' | 'warn' | 'bad';
/** Lit while there is a session, a ring when there is none, orange when it waits for a person, red when it is stuck. */
export type StateDot = 'on' | 'off' | 'busy' | 'bad';

export interface StateWord {
  word: string;
  dot: StateDot;
  tone: StateTone;
}

/** How an employee is: the office's own word for it, in lower case and without the marks made for the name tags. */
export function employeeState(activity: string, needsYou = false): StateWord {
  if (needsYou && activity !== 'needs_approval' && activity !== 'waiting_answer') return { word: 'needs you', dot: 'busy', tone: 'warn' };
  const word = (ACTIVITY_LABEL[activity] ?? activity.replace(/_/g, ' ')).replace(/^[?!✓]\s*/, '').toLowerCase();
  if (activity === 'needs_approval' || activity === 'waiting_answer') return { word, dot: 'busy', tone: 'warn' };
  if (activity === 'blocked') return { word, dot: 'bad', tone: 'bad' };
  if (activity === 'offline' || activity === 'unknown') return { word, dot: 'off', tone: 'calm' };
  return { word, dot: 'on', tone: 'calm' };
}

/**
 * The phrase under an employee's name: what they are, on what, and what they are doing now. The machine is said
 * only to somebody who has more than one (otherwise it is the same on every line).
 */
export function aboutEmployee(e: { title: string }, at: { project?: string | null; machine?: string | null; machines: number; task?: { key: string; title: string } | null }): string {
  return [e.title, at.project || null, at.machines > 1 ? at.machine || null : null, at.task ? `${at.task.key} ${at.task.title}` : null].filter(Boolean).join(' · ');
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The window's one line: how many people and how many of them work, the open tasks, and what waits — when anything does. */
export function myWorkLine(n: { employees: number; working: number; tasks: number; waiting: number }): string {
  const people = n.employees === 0 ? 'Nobody of your own yet' : `${count(n.employees, 'employee')}, ${n.working} working`;
  return [people, n.tasks > 0 ? count(n.tasks, 'open task') : null, n.waiting > 0 ? `${n.waiting} waiting for you` : null].filter(Boolean).join(' · ');
}

/** The states a task is in while there is still something to do about it, in the order one wants to hear of them. */
export const OPEN_ORDER: Task['status'][] = ['BLOCKED', 'REVIEW', 'IN_PROGRESS', 'READY', 'BACKLOG'];

/** How an open task stands: a word, coloured only where somebody is wanted (blocked, waiting to be reviewed). */
export function taskState(status: Task['status']): { word: string; tone: StateTone } {
  switch (status) {
    case 'BLOCKED':
      return { word: 'blocked', tone: 'bad' };
    case 'REVIEW':
      return { word: 'in review', tone: 'warn' };
    case 'IN_PROGRESS':
      return { word: 'in progress', tone: 'calm' };
    case 'READY':
      return { word: 'ready', tone: 'calm' };
    case 'BACKLOG':
      return { word: 'backlog', tone: 'calm' };
    default:
      return { word: status.toLowerCase().replace(/_/g, ' '), tone: 'calm' };
  }
}

/** What a question asks for, as the line in "Waiting for you" says it. */
export function askLine(name: string | undefined, kind: string): string {
  return `${name ?? 'An employee'} ${kind === 'permission' ? 'asks to be allowed something' : 'asks you something'}`;
}

/** How far a project is: "3 of 8 done", or that it has no tasks. */
export function projectLine(done: number, total: number): string {
  return total === 0 ? 'no tasks yet' : `${done} of ${total} done`;
}
