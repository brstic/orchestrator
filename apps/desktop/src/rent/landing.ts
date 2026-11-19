/**
 * The Rent portal (docs/RENT.md): which conversation a client lands in when they come in.
 */
import type { RentLine } from '@orchestrator/contracts';

/** Something new waits in this conversation: the employee (or the office) said something the client has not seen. */
export const isNew = (a: { id: string; last: RentLine | null }, seen: Record<string, string>): boolean => !!a.last && a.last.from !== 'client' && seen[a.id] !== a.last.id;

/**
 * Coming in: the conversation where something new waits (an employee wrote while they were away — `message_client`),
 * the newest first; null to keep the one they came back to (it has something new itself, or nothing is new anywhere).
 */
export function landOn(agents: Array<{ id: string; last: RentLine | null }>, seen: Record<string, string>, open: string | null): string | null {
  const fresh = agents.filter((a) => isNew(a, seen)).sort((a, b) => (a.last!.ts < b.last!.ts ? 1 : -1));
  if (!fresh.length || fresh.some((a) => a.id === open)) return null;
  return fresh[0]!.id;
}
