import type { Message } from './entities.ts';
import type { OrchestratorEvent } from './events.ts';

/**
 * What the owner's conversation with an employee (Talk) is made of — one rule for the server, which keeps and searches
 * the whole of it (`GET /employees/:id/talk`, `POST /employees/:id/talk/search`), and the window, which draws it:
 * what the boss (or a routine, or a Telegram group) said to them, and from the employee's record the answers, the files
 * they gave and a few notes (a task started or done, a question, a goal). A client of the Rent portal and the employee
 * is another conversation (Access → Rent), never this one.
 */
export const TALK_EVENT_TYPES = [
  'agent.turn_finished',
  'agent.file_given',
  'task.completed',
  'agent.goal',
  'task.blocked',
  'task.verification_failed',
  'task.started',
  'agent.question',
  'agent.status_report',
] as const;

/** A message that is a line of the boss's conversation with this employee. */
export function isTalkMessage(m: Message, employeeId: string): boolean {
  if (m.toEmployeeId !== employeeId || m.channel === 'rent') return false;
  return (m.channel === 'telegram' && !!m.chat) || m.from.kind === 'owner' || !!m.routineId;
}

/** What such a message says, as it is shown. */
export const talkTextOfMessage = (m: Message): string => `${m.said ?? m.body}${(m.files ?? []).map((f) => `\n${f.name}`).join('')}`;

/** The answer of a turn as it is shown — or null when it is not a line (nothing said, "NO_REPLY" in a group). */
export function talkReply(ev: OrchestratorEvent): string | null {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  if (typeof d.lastMessage !== 'string' || !d.lastMessage.trim() || /^\s*NO_REPLY\s*$/.test(d.lastMessage)) return null;
  return d.lastMessage.replace(/^\s*\[reply #\d+\]\s*/i, '');
}

/** Whether an event of the employee is a line of the conversation (not a client's turn, not a turn with nothing said). */
export function isTalkEvent(ev: OrchestratorEvent): boolean {
  const d = (ev.data ?? {}) as Record<string, any>;
  if (typeof d.rentClientId === 'string') return false;
  switch (ev.type) {
    case 'agent.turn_finished':
      return talkReply(ev) !== null;
    case 'agent.file_given':
      return !!d.file?.id && !!d.file?.name;
    case 'agent.goal':
      return d.phase === 'set' || d.phase === 'met' || d.phase === 'stopped';
    default:
      return (TALK_EVENT_TYPES as readonly string[]).includes(ev.type);
  }
}

/** What such an event says, as it is shown (an answer, a file's name and caption, or the note). */
export function talkTextOfEvent(ev: OrchestratorEvent): string {
  const d = (ev.data ?? {}) as Record<string, any>;
  if (ev.type === 'agent.turn_finished') return talkReply(ev) ?? '';
  if (ev.type === 'agent.file_given') return `${d.file?.name ?? ''}${typeof d.caption === 'string' ? `\n${d.caption}` : ''}`;
  return ev.summary;
}
