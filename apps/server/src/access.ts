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
 * A member can close their room. Then what is on their own computers is theirs alone: the owners of the
 * office and the foreman are kept out like everyone else (`closedTo`), until the member opens it again. Running
 * the office stays with the owners — they can still revoke that member or their machines.
 *
 * A route that is not listed here needs an owner: forgetting to list a new route fails closed.
 */
import { matchRole, roleByKey, type FullState, type Message, type OrchestratorEvent, type Question, type Routine } from '@orchestrator/contracts';
import { FOREMAN_ROLE, type Engine, type OutcomesScope } from '@orchestrator/orchestration';

export type Role = 'owner' | 'colleague' | 'visitor';

/** Who is making a request. `kind: 'owner'` is full rights: the root owner (id 'owner'), or a member whose role is owner. */
export type Who = { kind: 'owner'; id: string; name: string; role: 'owner' } | { kind: 'guest'; id: string; name: string; role: 'colleague' | 'visitor' };

/** read: look at it. work: change it, or reach into a machine. admin: run the office. */
export type Need = 'read' | 'work' | 'admin';

type Thing = 'employee' | 'task' | 'project' | 'session' | 'question' | 'host' | 'routine';
/** Whose a request is about: a thing named in the path (`:id`), or one named in the body. */
type Scope = { thing: Thing; from: 'path' } | { thing: Thing; from: 'body'; field: string };

interface Rule {
  method: string;
  re: RegExp;
  need: Need;
  scopes: Scope[];
  /** Only on the asker's own computer: the same act on something shared (or on someone else's) is an owner's. */
  ownOnly?: boolean;
}

const path = (thing: Thing): Scope => ({ thing, from: 'path' });
const inBody = (thing: Thing, field: string): Scope => ({ thing, from: 'body', field });
const rule = (method: string, pattern: string, need: Need, ...scopes: Scope[]): Rule => ({ method, re: new RegExp(`^${pattern.replace(/:id/g, '([^/]+)')}$`), need, scopes });

/** A rule that holds only for what lives on the member's own computer. */
const onOwn = (r: Rule): Rule => ({ ...r, ownOnly: true });

const RULES: Rule[] = [
  // ── the office as everyone sees it ──
  rule('GET', '/me', 'read'),
  // One's own password and one's own session: anybody who is in.
  rule('POST', '/me/password', 'read'),
  rule('POST', '/logout', 'read'),
  rule('GET', '/state', 'read'),
  rule('GET', '/people', 'read'),
  rule('GET', '/roles', 'read'),
  rule('GET', '/events', 'read'),
  rule('GET', '/performance', 'read'),
  rule('GET', '/layout/capacity', 'read'),
  rule('GET', '/radio/now', 'read'),
  // The hi-fi plays for the whole office: everyone hears what is on; switching a station on or off is for those who work here.
  rule('GET', '/radio', 'read'),
  rule('POST', '/radio/play', 'work'),
  rule('POST', '/radio/stop', 'work'),
  // How much of each Claude account is used (the clocks). Whose account it is, is told only to those who may work on that machine.
  rule('GET', '/usage', 'read'),
  // ── looking closer at one thing ──
  rule('GET', '/employees/:id/docs', 'read', path('employee')),
  rule('GET', '/employees/:id/docs/file', 'read', path('employee')),
  rule('GET', '/employees/:id/git', 'read', path('employee')),
  rule('GET', '/employees/:id/xp', 'read', path('employee')),
  rule('GET', '/tasks/:id/git', 'read', path('task')),
  // Files on a task: whoever may see the task may open them; whoever may work with it may add and remove them.
  rule('GET', '/tasks/:id/attachments/:id', 'read', path('task')),
  rule('GET', '/projects/:id/integration', 'read', path('project')),
  rule('GET', '/sessions/:id/history', 'read', path('session')),
  // ── a member's own computer ──
  rule('POST', '/me/host', 'work'),
  rule('GET', '/me/room', 'work'),
  rule('PUT', '/me/room', 'work'),
  // ── the door bell: seeing who knocks and answering (a colleague may only let someone in to look: checked in the route) ──
  rule('GET', '/knocks', 'work'),
  rule('POST', '/knocks/:id/admit', 'work'),
  rule('POST', '/knocks/:id/refuse', 'work'),
  // ── employees and their sessions ──
  rule('POST', '/employees', 'work', inBody('host', 'hostId'), inBody('project', 'projectId')),
  rule('PATCH', '/employees/:id', 'work', path('employee'), inBody('host', 'hostId'), inBody('project', 'projectId')),
  rule('POST', '/employees/:id/start', 'work', path('employee')),
  rule('POST', '/employees/:id/stop', 'work', path('employee')),
  rule('POST', '/employees/:id/pause', 'work', path('employee')),
  rule('POST', '/employees/:id/resume', 'work', path('employee')),
  rule('POST', '/employees/:id/message', 'work', path('employee')),
  rule('POST', '/employees/:id/report', 'work', path('employee')),
  // Routines: standing instructions repeated for one employee. Whoever may work with the employee may set them.
  rule('GET', '/routines', 'read'),
  rule('POST', '/routines', 'work', inBody('employee', 'employeeId')),
  rule('PATCH', '/routines/:id', 'work', path('routine')),
  rule('DELETE', '/routines/:id', 'work', path('routine')),
  rule('POST', '/routines/:id/run', 'work', path('routine')),
  rule('POST', '/sessions/attach', 'work', inBody('host', 'hostId'), inBody('employee', 'employeeId')),
  rule('POST', '/sessions/:id/adopt', 'work', path('session')),
  rule('POST', '/sessions/:id/bind', 'work', path('session'), inBody('employee', 'employeeId')),
  // ── reaching into a machine: its folders and what runs there ──
  rule('GET', '/hosts/:id/browse', 'work', path('host')),
  rule('GET', '/hosts/:id/claude-processes', 'work', path('host')),
  rule('GET', '/hosts/:id/discover', 'work', path('host')),
  // Servers a member brings into the office and may share with it. Whose a server is, is checked by the route itself.
  rule('GET', '/me/servers', 'work'),
  rule('POST', '/me/servers', 'work'),
  rule('PATCH', '/me/servers/:id', 'work'),
  rule('DELETE', '/me/servers/:id', 'work'),
  // ── projects and tasks ──
  rule('POST', '/projects', 'work', inBody('host', 'hostId')),
  rule('PATCH', '/projects/:id', 'work', path('project'), inBody('host', 'hostId')),
  rule('POST', '/projects/:id/pause', 'work', path('project')),
  rule('POST', '/projects/:id/resume', 'work', path('project')),
  rule('POST', '/projects/:id/plan', 'work', path('project')),
  rule('POST', '/projects/:id/integration/sync', 'work', path('project')),
  rule('POST', '/projects/:id/integration/test', 'work', path('project')),
  // A delete takes the project's tasks with it and cannot be undone: on what is shared it is an owner's act. A project
  // on a member's own computer has nobody else's work in it (work does not cross), so that member may delete it too.
  onOwn(rule('DELETE', '/projects/:id', 'work', path('project'))),
  // Deleting an employee for good: an owner anywhere, a colleague only their own employee on their own computer.
  onOwn(rule('DELETE', '/employees/:id', 'work', path('employee'))),
  rule('POST', '/tasks', 'work', inBody('project', 'projectId'), inBody('employee', 'assigneeId')),
  rule('POST', '/tasks/release', 'work', inBody('project', 'projectId'), inBody('task', 'ids')),
  rule('PATCH', '/tasks/:id', 'work', path('task'), inBody('employee', 'assigneeId')),
  rule('DELETE', '/tasks/:id', 'work', path('task')),
  rule('POST', '/tasks/:id/stop', 'work', path('task')),
  rule('POST', '/tasks/:id/correct', 'work', path('task')),
  rule('POST', '/tasks/:id/attachments', 'work', path('task')),
  rule('POST', '/tasks/:id/attachments/:id/data', 'work', path('task')),
  rule('DELETE', '/tasks/:id/attachments/:id', 'work', path('task')),
  rule('POST', '/tasks/:id/review', 'work', path('task')),
  rule('POST', '/tasks/:id/comments', 'work', path('task')),
  rule('POST', '/tasks/:id/send-back', 'work', path('task')),
  rule('POST', '/tasks/:id/unblock', 'work', path('task')),
  rule('POST', '/tasks/:id/retry-merge', 'work', path('task')),
  rule('POST', '/questions/:id/answer', 'work', path('question')),
  // ── the rest of working together ──
  rule('POST', '/notifications/read', 'work'),
  rule('POST', '/notifications/:id/resolve', 'work'),
  rule('POST', '/meetings', 'work'),
  rule('POST', '/meetings/:id/cancel', 'work'),
  rule('POST', '/lessons', 'work'),
  // ── the vault: whoever works in the office sees what it holds (names) and may add; values and removing are an owner's ──
  rule('GET', '/memory', 'read'),
  rule('POST', '/memory/recall', 'work'),
  rule('GET', '/vault', 'work'),
  rule('POST', '/vault', 'work'),
  rule('PATCH', '/lessons/:id', 'work'),
  rule('POST', '/commands/plan', 'work'),
  // Whether what the office learned helped. Counted, for anyone but an owner, only from what they may see (`outcomesScopeFor`).
  rule('GET', '/growth/outcomes', 'read'),
  // What the office did by itself with what it learned; each entry is filtered like any other event.
  rule('GET', '/growth/log', 'read'),
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
    case 'routine':
      return memberOf(engine, 'employee', core.routines.get(id)?.employeeId);
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

/**
 * Has the member this thing belongs to closed their room to this person? True for everyone but that member — the
 * owners of the office included. (The foreman's own things belong to no member and are never closed.)
 */
export function closedTo(engine: Engine, who: Who, member: string | null): boolean {
  return !!member && member !== OWNERS_ONLY && who.id !== member && engine.hosts.isClosed(member);
}

const CLOSED = 'Their room is closed: what is on their own computers is theirs alone until they open it again.';

/** `allowed`, with closed rooms taken into account: the question every check about one thing asks. */
function can(engine: Engine, who: Who, need: Need, member: string | null): boolean {
  return !closedTo(engine, who, member) && allowed(who, need, member);
}

export interface Verdict {
  ok: boolean;
  /** Why not, in words for the person. */
  reason?: string;
}

/** Decide one request to the owner API. `route` is the path under /api, without the query. */
export function mayCall(engine: Engine, who: Who, method: string, route: string, body: Record<string, unknown> | null | undefined): Verdict {
  const owner = who.kind === 'owner';
  for (const r of RULES) {
    if (r.method !== method) continue;
    const m = r.re.exec(route);
    if (!m) continue;
    if (!owner && !allowed(who, r.need, null)) return { ok: false, reason: who.role === 'visitor' ? 'You are visiting this office: you can look, not change anything.' : 'Only an owner of this office can do this.' };
    for (const s of r.scopes) {
      const raw = s.from === 'path' ? decodeURIComponent(m[1] ?? '') : body?.[s.field];
      // (A field that carries several ids — the tasks to release — is checked id by id; so is one that should
      // carry a single id and was sent as a list.)
      for (const one of Array.isArray(raw) ? (raw.length ? raw : [null]) : [raw]) {
      const id = typeof one === 'string' && one ? one : null;
      const member = memberOf(engine, s.thing, id);
      // A closed room is closed to owners as well: the one thing an owner is refused here.
      if (closedTo(engine, who, member)) return { ok: false, reason: CLOSED };
      if (owner) continue;
      if (r.ownOnly && !member) return { ok: false, reason: 'Only an owner of this office can do this to something shared.' };
      if (!allowed(who, r.need, member)) return { ok: false, reason: member === OWNERS_ONLY ? 'The foreman supervises the whole office, so only the owners can look into it or direct it.' : "That is on another member's own computer; only they and the owners can use it." };
      }
    }
    if (owner) return { ok: true };
    // Running without Claude Code's permission checks (the Unrestricted level) is an owner's to give.
    if (/^\/employees(\/[^/]+)?$/.test(route) && (method === 'POST' || method === 'PATCH') && body?.autonomy === 'unrestricted') {
      return { ok: false, reason: 'Only an owner of this office can put an employee on Unrestricted.' };
    }
    // What a project pre-approves, refuses and holds for approval decides what employees run unasked on the office's
    // machines (and the patterns are run as written, on every command): an owner's to set — or, for a project on a
    // member's own computer, that member's.
    // (The project window sends the whole policy with every save, so what counts is whether one of the three changes.)
    if (/^\/projects(\/[^/]+)?$/.test(route) && (method === 'POST' || method === 'PATCH') && body?.policy && typeof body.policy === 'object') {
      const id = method === 'PATCH' ? decodeURIComponent(m[1] ?? '') : null;
      const now = (id ? engine.core.projects.get(id)?.policy : null) as Record<string, unknown> | null | undefined;
      const changes = ['allow', 'deny', 'highRiskPatterns'].some((k) => k in (body.policy as object) && JSON.stringify((body.policy as Record<string, unknown>)[k] ?? []) !== JSON.stringify(now?.[k] ?? []));
      const mine = id ? memberOf(engine, 'project', id) : memberOf(engine, 'host', typeof body.hostId === 'string' ? body.hostId : null);
      if (changes && mine !== who.id) return { ok: false, reason: "Only an owner of this office can change what a shared project's employees may run without asking." };
    }
    // Hiring a foreman, or making someone the foreman, is an owner's act.
    if (/^\/employees(\/[^/]+)?$/.test(route) && (method === 'POST' || method === 'PATCH') && typeof body?.roleKey === 'string' && (roleByKey(body.roleKey) ?? matchRole(body.roleKey))?.key === FOREMAN_ROLE) {
      return { ok: false, reason: 'Only an owner of this office can hire a foreman.' };
    }
    return { ok: true };
  }
  return owner ? { ok: true } : { ok: false, reason: `Only an owner of this office can do this — you are here as a ${who.role}.` };
}

/** May this person see the terminal of a session (watch it, and the live monitor on its desk)? */
export function maySee(engine: Engine, who: Who, sessionId: string): boolean {
  return can(engine, who, 'read', memberOf(engine, 'session', sessionId));
}

/** May this person type into, resize or take control of a session's terminal? */
export function mayDrive(engine: Engine, who: Who, sessionId: string): boolean {
  return can(engine, who, 'work', memberOf(engine, 'session', sessionId));
}

// ── what is said on a member's own computer ──
// Everyone sees that a member's employee exists and what state it is in. What it says and is told — the feed lines about
// it (which carry its replies), the messages to and from it, its questions — is content of that member's computer: for
// the member and the owners.

/** The member whose computer an event is about; null when it is about the shared office. */
function memberOfEvent(engine: Engine, e: OrchestratorEvent): string | null {
  return memberOf(engine, 'host', e.hostId) ?? memberOf(engine, 'employee', e.employeeId) ?? memberOf(engine, 'session', e.sessionId) ?? memberOf(engine, 'project', e.projectId);
}

/**
 * Where the foreman is and that a round is on is for everyone to see (its character walks the office in every
 * window); what a round is about and what it concluded is the owners'. So these three are passed on with only that.
 */
const FOREMAN_PUBLIC: Record<string, (e: OrchestratorEvent) => Pick<OrchestratorEvent, 'summary' | 'data'>> = {
  'foreman.visit': (e) => ({ summary: e.summary, data: { fromEmployeeId: e.data.fromEmployeeId, toEmployeeId: e.data.toEmployeeId, roundId: e.data.roundId, action: e.data.action, quiet: e.data.quiet } }),
  'foreman.round.started': (e) => ({ summary: e.summary, data: { roundId: e.data.roundId, reason: e.data.reason, counts: e.data.counts } }),
  'foreman.round.finished': (e) => ({ summary: 'The foreman finished a round', data: { roundId: e.data.roundId, quiet: true } }),
};

/** An event as this person may read it: whole, with only what is public in it, or not at all (null). */
export function eventFor(engine: Engine, who: Who, e: OrchestratorEvent): OrchestratorEvent | null {
  // An owner reads everything — except what is said in a room its member has closed.
  if (who.kind === 'owner') return closedTo(engine, who, memberOfEvent(engine, e)) ? null : e;
  const pub = FOREMAN_PUBLIC[e.type];
  if (pub) return { ...e, sessionId: null, taskId: null, projectId: null, ...pub(e) };
  return can(engine, who, 'read', memberOfEvent(engine, e)) ? e : null;
}

/**
 * A message is read by whoever may read the one it was sent to. When another employee sent it, also by whoever may
 * read that one — except that the foreman as sender hides nothing: what it tells an employee is that employee's.
 */
export function mayReadMessage(engine: Engine, who: Who, m: Message): boolean {
  if (!can(engine, who, 'read', memberOf(engine, 'employee', m.toEmployeeId))) return false;
  const sender = m.from.kind === 'employee' ? memberOf(engine, 'employee', m.from.id) : null;
  return sender === OWNERS_ONLY || can(engine, who, 'read', sender);
}

export function mayReadQuestion(engine: Engine, who: Who, q: Question): boolean {
  return can(engine, who, 'read', memberOf(engine, 'employee', q.employeeId));
}

/** A routine says what an employee is told to do: read by whoever may read that employee. */
export function mayReadRoutine(engine: Engine, who: Who, r: Pick<Routine, 'employeeId'>): boolean {
  return can(engine, who, 'read', memberOf(engine, 'employee', r.employeeId));
}

/** The office's state as this person may read it. */
export function stateFor(engine: Engine, who: Who, state: FullState): FullState {
  // An owner reads the whole state unless some member has closed their room; then what is said there is left out for them too.
  if (who.kind === 'owner' && !engine.hosts.closedMembers().some((id) => id !== who.id)) return state;
  return { ...state, events: state.events.map((e) => eventFor(engine, who, e)).filter((e): e is OrchestratorEvent => !!e), messages: state.messages.filter((m) => mayReadMessage(engine, who, m)), questions: state.questions.filter((q) => mayReadQuestion(engine, who, q)), routines: (state.routines ?? []).filter((r) => mayReadRoutine(engine, who, r)) };
}

/**
 * What of the office's measured outcomes (GET /growth/outcomes) this person may see. An owner: everything (null).
 * Anyone else: what is shared and what is on their own computer — so the figures they get are counted without the
 * tasks, employees and projects of other members' computers, and the lessons and improvements about those are left out.
 */
export function outcomesScopeFor(engine: Engine, who: Who): OutcomesScope | null {
  if (who.kind === 'owner' && !engine.hosts.closedMembers().some((id) => id !== who.id)) return null;
  const reads = (thing: Thing) => (id: string) => can(engine, who, 'read', memberOf(engine, thing, id));
  return { task: (t) => reads('task')(t.id), employee: reads('employee'), project: reads('project') };
}
