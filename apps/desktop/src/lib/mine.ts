/**
 * Whose a thing is, for the person at this window. The office is shared, and everything in it is listed together;
 * someone who comes in wants to find their own first. "Mine" follows the machine, as everywhere else in the office
 * (`Host.memberId`): my computers and the servers I keep to myself, the employees on them, the projects that live
 * there, and the tasks of those projects or employees — plus the tasks I made myself, wherever they are, and the
 * shared employees I look after (`Employee.keptBy`: they stay shared, and are listed among mine).
 *
 * Pure: no store, no window. The switch between "Mine" and "Everyone" that the lists share is in `hud/mine.tsx`.
 */
import type { Employee, Host, Me, Project, Task } from '@orchestrator/contracts';

type Hosts = Record<string, Host>;

/**
 * mine: on a machine of mine, or a shared employee I look after (`kept`). shared: on one of the office's machines
 * (`keeper`: the member who looks after them, if any). member: on another member's own machine.
 */
export type Whose = { kind: 'mine'; kept?: boolean } | { kind: 'shared'; keeper?: string } | { kind: 'member'; name: string };

const SHARED: Whose = { kind: 'shared' };
const MINE: Whose = { kind: 'mine' };

/** Has this person machines of their own in the office (so that "Mine" means something)? */
export function hasOwn(hosts: Hosts, me: Me | null, employees: Record<string, Pick<Employee, 'keptBy' | 'archived'>> = {}): boolean {
  if (!me?.id || me.role === 'visitor') return false;
  return Object.values(hosts).some((h) => h.memberId === me.id && h.status !== 'revoked') || Object.values(employees).some((e) => !e.archived && e.keptBy?.id === me.id);
}

export function whoseHost(hosts: Hosts, me: Me | null, hostId: string | null | undefined): Whose {
  const host = hostId ? hosts[hostId] : undefined;
  if (!host?.memberId) return SHARED;
  return me?.id && host.memberId === me.id ? MINE : { kind: 'member', name: host.memberName || 'a member' };
}

export function whoseEmployee(hosts: Hosts, me: Me | null, e: Pick<Employee, 'hostId' | 'keptBy'> | undefined): Whose {
  const byMachine = whoseHost(hosts, me, e?.hostId);
  if (byMachine.kind !== 'shared' || !e?.keptBy) return byMachine;
  return me?.id && e.keptBy.id === me.id ? { kind: 'mine', kept: true } : { kind: 'shared', keeper: e.keptBy.name };
}

/** May this person take that employee among their own: a shared one, by a member (not at the office's own computer). */
export const mayKeep = (hosts: Hosts, me: Me | null, e: Pick<Employee, 'hostId' | 'roleKey' | 'archived'>): boolean =>
  !!me?.id && me.id !== 'owner' && me.role !== 'visitor' && !e.archived && e.roleKey !== 'foreman' && e.roleKey !== 'lead' && !!e.hostId && !!hosts[e.hostId] && !hosts[e.hostId]!.memberId;
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
  return w.kind === 'mine' ? (w.kept ? 'yours · shared' : 'yours') : w.kind === 'shared' ? (w.keeper ? `shared · ${w.keeper}` : 'shared') : w.name;
}

export type Scope = 'mine' | 'all';

/** What a list shows: mine alone, or everyone's with mine first. Without machines of one's own there is nothing to choose. */
export function scoped<T>(rows: readonly T[], scope: Scope, own: boolean, isMine: (row: T) => boolean): T[] {
  if (!own) return [...rows];
  return scope === 'mine' ? rows.filter(isMine) : mineFirst(rows, isMine);
}
