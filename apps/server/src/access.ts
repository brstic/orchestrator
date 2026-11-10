/**
 * Who may do what. Every request to the owner API and every message on the client WebSocket is
 * decided here, from three things: who is asking (their role), what the action needs, and whose
 * the thing they are acting on is.
 *
 *   visitor   — reads what is shared. Changes nothing.
 *   colleague — works on everything shared, and on what is on their own computer.
 *   owner     — everything, including what is on other members' computers.
 *
 * "Shared" and "personal" come from the machine: an employee, session, project, task or question
 * is personal exactly when the host it lives on belongs to a member (`Host.memberId`). Other
 * people see that a personal employee exists and what state it is in; its terminal, documents and
 * code are for its member and for owners.
 *
 * One employee is nobody's and not shared either: the foreman. It supervises the whole office, members'
 * own computers included, so what it sees is what an owner sees — its terminal, its documents and the
 * conversation with it are for owners only, and only an owner can hire one or change who it is. Everyone
 * still sees that it is there and what it is doing.
 *
 * A route that is not listed here needs an owner: forgetting to list a new route fails closed.
 */
import { FOREMAN_ROLE, type Engine } from '@orchestrator/orchestration';
import { matchRole, roleByKey } from '@orchestrator/contracts';

export type Role = 'owner' | 'colleague' | 'visitor';

/** Who is making a request. `kind: 'owner'` is full rights: the root owner (id 'owner'), or a member whose role is owner. */
export type Who = { kind: 'owner'; id: string; name: string; role: 'owner' } | { kind: 'guest'; id: string; name: string; role: 'colleague' | 'visitor' };

/** read: look at it. work: change it, or reach into a machine. admin: run the office. */
export type Need = 'read' | 'work' | 'admin';

type Thing = 'employee' | 'task' | 'project' | 'session' | 'question' | 'host';
/** Whose a request is about: a thing named in the path (`:id`), or one named in the body. */
type Scope = { thing: Thing; from: 'path' } | { thing: Thing; from: 'body'; field: string };

interface Rule {
  method: string;
  re: RegExp;
  need: Need;
  scopes: Scope[];
}

const path = (thing: Thing): Scope => ({ thing, from: 'path' });
const inBody = (thing: Thing, field: string): Scope => ({ thing, from: 'body', field });
const rule = (method: string, pattern: string, need: Need, ...scopes: Scope[]): Rule => ({ method, re: new RegExp(`^${pattern.replace(/:id/g, '([^/]+)')}$`), need, scopes });

const RULES: Rule[] = [
  // ── the office as everyone sees it ──
  rule('GET', '/me', 'read'),
  rule('GET', '/state', 'read'),
  rule('GET', '/people', 'read'),
  rule('GET', '/roles', 'read'),
  rule('GET', '/events', 'read'),
  rule('GET', '/performance', 'read'),
  rule('GET', '/layout/capacity', 'read'),
  rule('GET', '/radio/now', 'read'),
  // How much of each Claude account is used (the clocks). Whose account it is, is told only to those who may work on that machine.
  rule('GET', '/usage', 'read'),
  // ── looking closer at one thing ──
  rule('GET', '/employees/:id/docs', 'read', path('employee')),
  rule('GET', '/employees/:id/docs/file', 'read', path('employee')),
  rule('GET', '/employees/:id/git', 'read', path('employee')),
  rule('GET', '/employees/:id/xp', 'read', path('employee')),
  rule('GET', '/tasks/:id/git', 'read', path('task')),
  rule('GET', '/projects/:id/integration', 'read', path('project')),
  rule('GET', '/sessions/:id/history', 'read', path('session')),
  // ── a member's own computer ──
  rule('POST', '/me/host', 'work'),
  rule('GET', '/me/room', 'work'),
  rule('PUT', '/me/room', 'work'),
  // ── employees and their sessions ──
  rule('POST', '/employees', 'work', inBody('host', 'hostId'), inBody('project', 'projectId')),
  rule('PATCH', '/employees/:id', 'work', path('employee'), inBody('host', 'hostId'), inBody('project', 'projectId')),
  rule('POST', '/employees/:id/start', 'work', path('employee')),
  rule('POST', '/employees/:id/stop', 'work', path('employee')),
  rule('POST', '/employees/:id/pause', 'work', path('employee')),
  rule('POST', '/employees/:id/resume', 'work', path('employee')),
  rule('POST', '/employees/:id/message', 'work', path('employee')),
  rule('POST', '/employees/:id/report', 'work', path('employee')),
  rule('POST', '/sessions/attach', 'work', inBody('host', 'hostId'), inBody('employee', 'employeeId')),
  rule('POST', '/sessions/:id/adopt', 'work', path('session')),
  rule('POST', '/sessions/:id/bind', 'work', path('session'), inBody('employee', 'employeeId')),
  // ── reaching into a machine: its folders and what runs there ──
  rule('GET', '/hosts/:id/browse', 'work', path('host')),
  rule('GET', '/hosts/:id/claude-processes', 'work', path('host')),
  rule('GET', '/hosts/:id/discover', 'work', path('host')),
  // ── projects and tasks ──
  rule('POST', '/projects', 'work', inBody('host', 'hostId')),
  rule('PATCH', '/projects/:id', 'work', path('project'), inBody('host', 'hostId')),
  rule('POST', '/projects/:id/pause', 'work', path('project')),
  rule('POST', '/projects/:id/resume', 'work', path('project')),
  rule('POST', '/projects/:id/plan', 'work', path('project')),
  rule('POST', '/projects/:id/integration/sync', 'work', path('project')),
  rule('POST', '/projects/:id/integration/test', 'work', path('project')),
  rule('POST', '/tasks', 'work', inBody('project', 'projectId'), inBody('employee', 'assigneeId')),
  rule('POST', '/tasks/release', 'work', inBody('project', 'projectId')),
  rule('PATCH', '/tasks/:id', 'work', path('task'), inBody('employee', 'assigneeId')),
  rule('DELETE', '/tasks/:id', 'work', path('task')),
  rule('POST', '/tasks/:id/review', 'work', path('task')),
  rule('POST', '/tasks/:id/unblock', 'work', path('task')),
  rule('POST', '/tasks/:id/retry-merge', 'work', path('task')),
  rule('POST', '/questions/:id/answer', 'work', path('question')),
  // ── the rest of working together ──
  rule('POST', '/notifications/read', 'work'),
  rule('POST', '/notifications/:id/resolve', 'work'),
  rule('POST', '/meetings', 'work'),
  rule('POST', '/meetings/:id/cancel', 'work'),
  rule('POST', '/lessons', 'work'),
  rule('PATCH', '/lessons/:id', 'work'),
  rule('POST', '/commands/plan', 'work'),
];

/** In place of a member's id: the thing is the foreman's (its profile, its session, its questions), which only owners may touch or look into. */
export const OWNERS_ONLY = '#owners';

/**
 * The member a thing belongs to; null when it is shared (or does not exist: the route then answers 404 itself).
 * What is the foreman's belongs to no member and is not shared: `OWNERS_ONLY`.
 */
export function memberOf(engine: Engine, thing: Thing, id: string | null | undefined): string | null {
  if (!id) return null;
  const core = engine.core;
  const ofHost = (hostId: string | null | undefined): string | null => (hostId ? (core.hosts.get(hostId)?.memberId ?? null) : null);
  const ofEmployee = (employeeId: string | null | undefined): string | null => {
    const e = employeeId ? core.employees.get(employeeId) : undefined;
    return e?.roleKey === FOREMAN_ROLE ? OWNERS_ONLY : ofHost(e?.hostId);
  };
  switch (thing) {
    case 'host':
      return ofHost(id);
    case 'employee':
      return ofEmployee(id);
    case 'session': {
      const s = core.sessions.get(id);
      return s?.employeeId && core.employees.get(s.employeeId)?.roleKey === FOREMAN_ROLE ? OWNERS_ONLY : ofHost(s?.hostId);
    }
    case 'project':
      return ofHost(core.projects.get(id)?.hostId);
    case 'task': {
      const t = core.tasks.get(id);
      return t ? (ofHost(core.projects.get(t.projectId)?.hostId) ?? memberOf(engine, 'employee', t.assigneeId)) : null;
    }
    case 'question':
      return memberOf(engine, 'employee', core.questions.get(id)?.employeeId);
  }
}

/** May this person do something that needs `need` to a thing that is `member`'s (null: shared)? */
export function allowed(who: Who, need: Need, member: string | null): boolean {
  if (who.kind === 'owner') return true;
  if (need === 'admin') return false;
  // Someone's own computer: theirs alone (and the owners').
  if (member) return who.role === 'colleague' && who.id === member;
  return need === 'read' || who.role === 'colleague';
}

export interface Verdict {
  ok: boolean;
  /** Why not, in words for the person. */
  reason?: string;
}

/** Decide one request to the owner API. `route` is the path under /api, without the query. */
export function mayCall(engine: Engine, who: Who, method: string, route: string, body: Record<string, unknown> | null | undefined): Verdict {
  if (who.kind === 'owner') return { ok: true };
  for (const r of RULES) {
    if (r.method !== method) continue;
    const m = r.re.exec(route);
    if (!m) continue;
    if (!allowed(who, r.need, null)) return { ok: false, reason: who.role === 'visitor' ? 'You are visiting this office: you can look, not change anything.' : 'Only an owner of this office can do this.' };
    for (const s of r.scopes) {
      const raw = s.from === 'path' ? decodeURIComponent(m[1] ?? '') : body?.[s.field];
      const id = typeof raw === 'string' && raw ? raw : null;
      const member = memberOf(engine, s.thing, id);
      if (!allowed(who, r.need, member)) return { ok: false, reason: member === OWNERS_ONLY ? 'The foreman supervises the whole office, so only the owners can look into it or direct it.' : "That is on another member's own computer; only they and the owners can use it." };
    }
    // Hiring a foreman, or making someone the foreman, is an owner's act.
    if (/^\/employees(\/[^/]+)?$/.test(route) && (method === 'POST' || method === 'PATCH') && typeof body?.roleKey === 'string' && (roleByKey(body.roleKey) ?? matchRole(body.roleKey))?.key === FOREMAN_ROLE) {
      return { ok: false, reason: 'Only an owner of this office can hire a foreman.' };
    }
    return { ok: true };
  }
  return { ok: false, reason: `Only an owner of this office can do this — you are here as a ${who.role}.` };
}

/** May this person see the terminal of a session (watch it, and the live monitor on its desk)? */
export function maySee(engine: Engine, who: Who, sessionId: string): boolean {
  return allowed(who, 'read', memberOf(engine, 'session', sessionId));
}

/** May this person type into, resize or take control of a session's terminal? */
export function mayDrive(engine: Engine, who: Who, sessionId: string): boolean {
  return allowed(who, 'work', memberOf(engine, 'session', sessionId));
}
