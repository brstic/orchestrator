/**
 * Whose a thing is, for the person at this window. The office is shared, and everything in it is listed together;
 * someone who comes in wants to find their own first. "Mine" follows the machine, as everywhere else in the office
 * (`Host.memberId`): my computers and the servers I keep to myself, the employees on them, the projects that live
 * there, and the tasks of those projects or employees — plus the tasks I made myself, wherever they are.
 *
 * Pure: no store, no window. The switch between "Mine" and "Everyone" that the lists share is in `hud/mine.tsx`.
 */
import type { Employee, Host, Me, Project, Task } from '@orchestrator/contracts';

type Hosts = Record<string, Host>;

/** mine: on a machine of mine. shared: on one of the office's machines. member: on another member's own machine. */
export type Whose = { kind: 'mine' } | { kind: 'shared' } | { kind: 'member'; name: string };

const SHARED: Whose = { kind: 'shared' };
const MINE: Whose = { kind: 'mine' };

/** Has this person machines of their own in the office (so that "Mine" means something)? */
export function hasOwn(hosts: Hosts, me: Me | null): boolean {
  return !!me?.id && me.role !== 'visitor' && Object.values(hosts).some((h) => h.memberId === me.id && h.status !== 'revoked');
}

export function whoseHost(hosts: Hosts, me: Me | null, hostId: string | null | undefined): Whose {
  const host = hostId ? hosts[hostId] : undefined;
  if (!host?.memberId) return SHARED;
  return me?.id && host.memberId === me.id ? MINE : { kind: 'member', name: host.memberName || 'a member' };
}

export const whoseEmployee = (hosts: Hosts, me: Me | null, e: Pick<Employee, 'hostId'> | undefined): Whose => whoseHost(hosts, me, e?.hostId);
export const whoseProject = (hosts: Hosts, me: Me | null, p: Pick<Project, 'hostId'> | undefined): Whose => whoseHost(hosts, me, p?.hostId);

/** How the office writes down who made something: `owner` at the office's own computer, `member:<name>` otherwise. */
export const actorOf = (me: Me | null): string | null => (!me ? null : me.id === 'owner' || !me.id ? 'owner' : `member:${me.name}`);

/**
 * A task is whose its project's machine is, else whose its assignee is (the office's own rule, `memberOf` in its
 * `access.ts`). A task on shared ground that I made myself is still "mine" to find — `madeByMe` says so.
 */
export function whoseTask(hosts: Hosts, me: Me | null, t: Pick<Task, 'projectId' | 'assigneeId'>, projects: Record<string, Project>, employees: Record<string, Employee>): Whose {
  const byProject = whoseProject(hosts, me, projects[t.projectId]);
  return byProject.kind !== 'shared' ? byProject : whoseEmployee(hosts, me, t.assigneeId ? employees[t.assigneeId] : undefined);
}

export const madeByMe = (me: Me | null, t: Pick<Task, 'createdBy'>): boolean => !!me && me.role !== 'visitor' && !!t.createdBy && t.createdBy === actorOf(me);

/** Is this task one of mine to look at first: on my machines, with my employee, or made by me? */
export function taskIsMine(hosts: Hosts, me: Me | null, t: Pick<Task, 'projectId' | 'assigneeId' | 'createdBy'>, projects: Record<string, Project>, employees: Record<string, Employee>): boolean {
  return whoseTask(hosts, me, t, projects, employees).kind === 'mine' || madeByMe(me, t);
}

/** The same rows with mine first; the order within each part is kept. */
export function mineFirst<T>(rows: readonly T[], isMine: (row: T) => boolean): T[] {
  return [...rows.filter(isMine), ...rows.filter((r) => !isMine(r))];
}

/** A few words for a badge: "yours", "shared", or whose it is. */
export function whoseLabel(w: Whose): string {
  return w.kind === 'mine' ? 'yours' : w.kind === 'shared' ? 'shared' : w.name;
}

export type Scope = 'mine' | 'all';

/** What a list shows: mine alone, or everyone's with mine first. Without machines of one's own there is nothing to choose. */
export function scoped<T>(rows: readonly T[], scope: Scope, own: boolean, isMine: (row: T) => boolean): T[] {
  if (!own) return [...rows];
  return scope === 'mine' ? rows.filter(isMine) : mineFirst(rows, isMine);
}
