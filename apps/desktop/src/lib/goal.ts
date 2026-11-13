import type { EmployeeGoal } from '@orchestrator/contracts';

/**
 * `/goal` typed in the box one talks to an employee in — as in Claude Code: `/goal <what has to be true>` gives them a
 * goal, `/goal clear` takes it away, `/goal` on its own says what it is. Anything else is a message.
 */
export type GoalCommand = { kind: 'set'; condition: string } | { kind: 'clear' } | { kind: 'show' };

export function goalCommand(text: string): GoalCommand | null {
  const m = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const rest = (m[1] ?? '').trim();
  if (!rest) return { kind: 'show' };
  if (/^(clear|stop|off|cancel)$/i.test(rest)) return { kind: 'clear' };
  return { kind: 'set', condition: rest };
}

/** How a goal stands, in a few words: what the line about it says. */
export function goalWords(g: EmployeeGoal): string {
  if (g.status === 'active') return g.turns ? `sent on ${g.turns} ${g.turns === 1 ? 'time' : 'times'}` : 'just given';
  if (g.status === 'met') return 'met';
  return 'stopped';
}

/** A goal that ended is still worth a line for a while: whoever gave it sees how it went. */
export function goalStillShown(g: EmployeeGoal | null | undefined, now = Date.now()): boolean {
  if (!g) return false;
  if (g.status === 'active') return true;
  return !!g.endedAt && now - Date.parse(g.endedAt) < 2 * 3_600_000;
}
