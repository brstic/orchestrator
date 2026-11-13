import type { Employee, EmployeeOfMonth } from '@orchestrator/contracts';
import type { AwardView } from '@orchestrator/office-3d';

/**
 * The employee of the month, as the office's record has it (`CompanyStats.employeeOfMonth`, kept by the server's
 * work log) → what the board of that name shows. Plain functions, so that they can be tested without a window.
 */

/** The month of an "employee of the month" record ("2026-11") as people say it: "November 2026". */
export function monthWords(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return y && m && names[m - 1] ? `${names[m - 1]} ${y}` : month;
}

/** The employee of the month, for the board of that name: null until anybody has worked, or when they are no longer here. */
export function awardView(company: { employeeOfMonth?: EmployeeOfMonth | null } | null | undefined, employees: Record<string, Pick<Employee, 'id' | 'name' | 'title' | 'appearance' | 'archived'>>): AwardView | null {
  const best = company?.employeeOfMonth;
  const e = best ? employees[best.employeeId] : undefined;
  if (!best || !e || e.archived) return null;
  return { employeeId: e.id, name: e.name, title: e.title, appearance: e.appearance, month: monthWords(best.month), hours: Math.floor(best.ms / 3_600_000) };
}
