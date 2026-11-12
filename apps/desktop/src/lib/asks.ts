/**
 * "I said something to an employee and am waiting to hear back" — what the dots over their head stand for.
 *
 * The answer is the end of their turn (`agent.turn_finished`), and that is what normally ends the wait. But that one
 * event can fail to come, or come while nobody is looking: the turn was interrupted or ended in an error, the session
 * was stopped, the employee was let go, or this window was closed for the night and the event is no longer among the
 * ones the office sends on arrival. So the wait is also measured against what the office says *now*: dots are shown
 * only while somebody can really be working on what was said, and a wait that is evidently over is ended.
 *
 * Plain functions of the office's state (no store, no browser), so the tests run them directly.
 */

/** What this computer remembers of something I said: the office's message, and when (this computer's clock). */
export interface Ask {
  messageId: string | null;
  at: number;
}

export interface AskFacts {
  ask: Ask;
  /** The employee as the office has them now (undefined: gone). */
  employee: { archived?: boolean } | undefined;
  /** Their session, the live one if there is one. */
  session: { status: string; inTurn: boolean | null; activity: string } | undefined;
  /** How the delivery of my message stands (undefined: the office no longer lists the message). */
  delivery: { status: string; ts: string | null } | undefined;
  /** This computer's clock. */
  now: number;
}

/**
 * - `working`: they are on it, or it is on its way to a session that is up — the dots.
 * - `pending`: it waits for someone who is not at work; kept, but nothing is shown (nobody is thinking).
 * - `over`: nothing more will come of this wait.
 */
export type AskState = 'working' | 'pending' | 'over';

/** How long a message that was typed into a session may go unacknowledged before the wait is called off. */
export const UNACKNOWLEDGED_MS = 30_000;
/** How long a wait has to look over before it is ended (the answer itself arrives a moment after the session rests). */
export const SETTLE_MS = 4_000;

const WORKING = new Set(['thinking', 'reading', 'coding', 'testing', 'debugging', 'running_command', 'researching', 'planning', 'reviewing', 'delegating']);

export function askState({ ask, employee, session, delivery, now }: AskFacts): AskState {
  if (!employee || employee.archived) return 'over';
  // A message the office no longer lists was typed in when it was said, as far as anybody can tell.
  const status = delivery?.status ?? 'sent';
  if (status === 'failed') return 'over';
  const live = !!session && (session.status === 'running' || session.status === 'starting');
  // Not handed over yet: it is given to them between turns, or when they are started.
  if (status === 'queued' || status === 'none') return live ? 'working' : 'pending';
  // It reached their session.
  if (!live) return 'over';
  if (session!.inTurn === true) return 'working';
  const recent = now - ask.at < UNACKNOWLEDGED_MS;
  // Between turns. Acknowledged by Claude Code: the turn it started has ended. Only typed in: a moment for it to start.
  if (session!.inTurn === false) return status === 'confirmed' ? 'over' : recent ? 'working' : 'over';
  // A session that reports no turns (no hooks): by what it is seen doing.
  return WORKING.has(session!.activity) || recent ? 'working' : 'over';
}

export interface TurnEnd {
  type: string;
  employeeId?: string | null;
  ts: string;
  data?: unknown;
}

/**
 * The answer to a wait that ended unseen: the employee's last finished turn since my message reached them (the
 * office's clock on both sides; for a message the office no longer lists, since I said it). Null when there is none
 * — the turn was cut short, or it is too long ago for the office to still be sending it.
 */
export function answerAmong(events: readonly TurnEnd[], employeeId: string, ask: Ask, delivery: { ts: string | null } | undefined): { text: string; ts: string } | null {
  const since = Date.parse(delivery?.ts ?? '') || ask.at;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type !== 'agent.turn_finished' || ev.employeeId !== employeeId) continue;
    if (Date.parse(ev.ts) < since) return null;
    return { text: String((ev.data as { lastMessage?: unknown } | undefined)?.lastMessage ?? '').trim(), ts: ev.ts };
  }
  return null;
}
