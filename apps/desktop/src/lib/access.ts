/**
 * What the person at this window may do, mirrored from the office's own rules (`apps/server/src/access.ts`)
 * so that controls they cannot use are hidden or explained instead of left to fail. The office decides;
 * this only saves a refused click.
 */
import type { Employee, Host, Me } from '@orchestrator/contracts';
import { useOffice } from './store.ts';

type Hosts = Record<string, Host>;

/**
 * Before a member's id: that member has closed their room, so what is on their computers is theirs alone — owners
 * included (`closedTo` in the office's `access.ts`). `may` reads it; `memberIdOf` gives the plain id back.
 */
const CLOSED = '#closed:';
export const memberIdOf = (member: string | null): string | null => (member?.startsWith(CLOSED) ? member.slice(CLOSED.length) : member);

/** The member a machine belongs to; null for a shared machine. (Marked when that member has closed their room.) */
export const memberOfHost = (hosts: Hosts, hostId: string | null | undefined): string | null => {
  const host = hostId ? hosts[hostId] : undefined;
  return host?.memberId ? (host.room?.locked ? `${CLOSED}${host.memberId}` : host.memberId) : null;
};

/** In place of a member's id: the foreman's own things, which only owners may look into or direct (as the office's `access.ts` has it). */
export const OWNERS_ONLY = '#owners';

/** Whose an employee is: a member's (their own computer), the owners' alone (the foreman), or null — shared. */
export const memberOfEmployee = (hosts: Hosts, e: Pick<Employee, 'hostId' | 'roleKey'> | undefined): string | null => (e?.roleKey === 'foreman' ? OWNERS_ONLY : memberOfHost(hosts, e?.hostId));

export function may(me: Me | null, need: 'read' | 'work' | 'admin', member: string | null): boolean {
  if (!me) return false;
  // A closed room: its member alone, whoever else asks.
  if (member?.startsWith(CLOSED) && me.id !== memberIdOf(member)) return false;
  if (me.kind === 'owner') return true;
  if (need === 'admin') return false;
  if (member) return me.role === 'colleague' && me.id === memberIdOf(member);
  return need === 'read' || me.role === 'colleague';
}

/** Why not, in a few words for a tooltip. */
export function whyNot(me: Me | null, need: 'read' | 'work' | 'admin', member: string | null): string | null {
  if (may(me, need, member)) return null;
  if (member?.startsWith(CLOSED)) return 'Their room is closed: what is on their own computers is theirs alone until they open it again.';
  if (need === 'admin') return 'Only an owner of this office can do this.';
  if (member === OWNERS_ONLY) return 'The foreman supervises the whole office: only its owners can look into it or direct it.';
  if (member) return "This is on another member's own computer.";
  return 'You are visiting this office: you can look, not change anything.';
}

/** For components: `const can = useAccess(); can.work(employee.hostId)`. */
export function useAccess() {
  const me = useOffice((s) => s.me);
  const hosts = useOffice((s) => s.hosts);
  return {
    me,
    owner: me?.kind === 'owner',
    visitor: me?.role === 'visitor',
    /** The root owner, at the office's own computer (their sessions are the shared ones). */
    root: me?.id === 'owner' || (me?.kind === 'owner' && !me?.id),
    read: (hostId: string | null | undefined) => may(me, 'read', memberOfHost(hosts, hostId)),
    work: (hostId: string | null | undefined) => may(me, 'work', memberOfHost(hosts, hostId)),
    why: (hostId: string | null | undefined, need: 'read' | 'work' = 'work') => whyNot(me, need, memberOfHost(hosts, hostId)),
    admin: me?.kind === 'owner',
    /** Deleting a project: an owner's act, except for a project on one's own computer (nobody else's work is there). */
    deleteProject: (hostId: string | null | undefined) => me?.kind === 'owner' || (me?.role === 'colleague' && !!memberOfHost(hosts, hostId) && memberIdOf(memberOfHost(hosts, hostId)) === me.id),
    /** Deleting an employee for good: the same rule as a project. */
    deleteEmployee: (hostId: string | null | undefined) => me?.kind === 'owner' || (me?.role === 'colleague' && !!memberOfHost(hosts, hostId) && memberIdOf(memberOfHost(hosts, hostId)) === me.id),
    /** Machines this person may put employees on: the shared ones, and their own. */
    usable: (h: Host) => may(me, 'work', h.memberId ?? null),
  };
}

/**
 * Is this machine the computer this window is on? Then the system's own folder dialog shows the right disk. True for
 * the member's own host that the desktop app brought into the office, and for an office that runs on this very computer.
 */
export function isThisComputer(host: Host | undefined, myHostId: string | null): boolean {
  if (!host) return false;
  if (host.memberId) return host.id === myHostId;
  return host.local && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
}
