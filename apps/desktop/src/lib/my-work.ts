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
 * What an employee is, for whoever opens their line: their title, their project, and the machine — the machine only
 * to somebody who has more than one (otherwise it is the same for everybody) — and the model they run on.
 */
export function aboutEmployee(e: { title: string; model?: string | null }, at: { project?: string | null; machine?: string | null; machines: number }): string {
  return [e.title, at.project || null, at.machines > 1 ? at.machine || null : null, e.model || null].filter(Boolean).join(' · ');
}

/** Who is listed first: whoever wants somebody, then whoever is at work, then whoever sleeps; by name within each. */
export function byAttention<T extends { name: string; state: StateWord }>(people: readonly T[]): T[] {
  const rank = (s: StateWord): number => (s.tone === 'bad' ? 0 : s.tone === 'warn' ? 1 : s.dot === 'off' ? 3 : 2);
  return [...people].sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
}

export interface TaskLike {
  id: string;
  projectId: string;
  status: Task['status'];
}
export interface ProjectLike {
  id: string;
  name: string;
}
export interface TaskGroup<T, P> {
  project: P | null;
  /** One of my own projects (it is listed even with nothing open in it). */
  mine: boolean;
  tasks: T[];
  /** How many more open tasks of this project there are than are listed. */
  more: number;
}

/**
 * The open tasks, by project: my own projects first (each of them, even with nothing open), then whichever other
 * projects have a task of mine. No more than `most` tasks are listed in all — the board has the rest — and a
 * project says how many of its own were left out.
 */
export function tasksByProject<T extends TaskLike, P extends ProjectLike>(tasks: readonly T[], mine: readonly P[], all: Record<string, P | undefined>, most: number): Array<TaskGroup<T, P>> {
  const groups = new Map<string, TaskGroup<T, P>>();
  for (const p of [...mine].sort((a, b) => a.name.localeCompare(b.name))) groups.set(p.id, { project: p, mine: true, tasks: [], more: 0 });
  const others: Array<TaskGroup<T, P>> = [];
  let left = most;
  for (const t of tasks) {
    let g = groups.get(t.projectId);
    if (!g) {
      g = { project: all[t.projectId] ?? null, mine: false, tasks: [], more: 0 };
      groups.set(t.projectId, g);
      others.push(g);
    }
    if (left > 0) {
      g.tasks.push(t);
      left--;
    } else g.more++;
  }
  others.sort((a, b) => (a.project?.name ?? '').localeCompare(b.project?.name ?? ''));
  return [...[...groups.values()].filter((g) => g.mine), ...others];
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
