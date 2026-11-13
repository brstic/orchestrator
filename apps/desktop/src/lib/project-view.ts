/**
 * How a project stands, as the Projects window says it (docs/UI.md): what part of its tasks is where, in one bar
 * and one line. Nothing here touches the page.
 */

export type Part = 'done' | 'review' | 'doing' | 'blocked' | 'waiting';

export interface Progress {
  total: number;
  done: number;
  /** The parts that have anything, in the order of the bar: done, in review, in progress, blocked, not started. */
  parts: Array<{ part: Part; n: number; percent: number; word: string }>;
  /** "3 of 8 done · 2 in progress · 1 blocked", or that there is nothing yet. */
  line: string;
}

const PART_OF: Record<string, Part> = { DONE: 'done', REVIEW: 'review', IN_PROGRESS: 'doing', ASSIGNED: 'doing', BLOCKED: 'blocked', READY: 'waiting', BACKLOG: 'waiting' };
const WORD: Record<Part, string> = { done: 'done', review: 'in review', doing: 'in progress', blocked: 'blocked', waiting: 'not started' };
const ORDER: Part[] = ['done', 'review', 'doing', 'blocked', 'waiting'];

/** Where a project's tasks are. A state the office learns tomorrow counts as not started. */
export function progressOf(tasks: ReadonlyArray<{ status: string }>): Progress {
  const n: Record<Part, number> = { done: 0, review: 0, doing: 0, blocked: 0, waiting: 0 };
  for (const t of tasks) n[PART_OF[t.status] ?? 'waiting']++;
  const total = tasks.length;
  const parts = ORDER.filter((p) => n[p] > 0).map((part) => ({ part, n: n[part], percent: (n[part] / total) * 100, word: WORD[part] }));
  const line = total === 0 ? 'No tasks yet' : [`${n.done} of ${total} done`, ...(['review', 'doing', 'blocked'] as const).filter((p) => n[p] > 0).map((p) => `${n[p]} ${WORD[p]}`)].join(' · ');
  return { total, done: n.done, parts, line };
}

/** The projects' own line in the window's head: how many, and how many of them are going. */
export function projectsLine(projects: ReadonlyArray<{ status: string }>): string {
  const live = projects.filter((p) => p.status !== 'archived');
  if (live.length === 0) return 'None yet';
  const paused = live.filter((p) => p.status === 'paused').length;
  return `${live.length} project${live.length === 1 ? '' : 's'}${paused ? ` · ${paused} paused` : ''}`;
}
