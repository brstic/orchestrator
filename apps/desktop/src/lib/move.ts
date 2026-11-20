import type { EmployeeMoving } from '@orchestrator/contracts';

/**
 * How far an employee's move to another machine is (`docs/MOVE.md`), for the profile and for the office, where it
 * stands over their head: 0 while their desk is packed (how long that takes is not known before), then what has been
 * sent of all there is, and 99 while it is unpacked on the other machine — 100 is when they are there.
 */
export function movePercent(m: EmployeeMoving | null | undefined): number | null {
  if (!m || m.phase === 'failed') return null;
  if (m.phase === 'packing') return 0;
  if (m.phase === 'unpacking') return 99;
  return m.total > 0 ? Math.min(99, Math.floor((m.sent / m.total) * 100)) : 0;
}

const size = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The move in a line: what is being done, to where. */
export function moveLine(m: EmployeeMoving, toName: string): string {
  if (m.phase === 'failed') return `Moving to ${toName} failed: ${m.error ?? 'no reason was given'}`;
  if (m.phase === 'packing') return `Packing their desk for ${toName}…`;
  if (m.phase === 'unpacking') return `Unpacking on ${toName}…`;
  return `Carrying it to ${toName}: ${movePercent(m)} % (${size(m.sent)} of ${size(m.total)})`;
}
