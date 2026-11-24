/**
 * Who may do what. Every request to the owner API and every message on the client WebSocket is
 * decided here, from three things: who is asking (their role), what the action needs, and whose
 * the thing they are acting on is.
 *
 *   visitor   — looks at the office: who is here, who works on what, how the shared work stands, the shared terminals.
 *               Changes nothing, and is not sent what the office runs on or what is said in it (`shownTo`).
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
import { matchRole, notificationFor, roleByKey, type AgentSession, type Employee, type EntityKind, type FullState, type Host, type Meeting, type Message, type OrchestratorEvent, type OwnerSettings, type Project, type Question, type Routine, type Task } from '@orchestrator/contracts';
import { FOREMAN_ROLE, type Engine, type OutcomesScope } from '@orchestrator/orchestration';

export type Role = 'owner' | 'colleague' | 'visitor';

/** Who is making a request. `kind: 'owner'` is full rights: the root owner (id 'owner'), or a member whose role is owner. */
export type Who = { kind: 'owner'; id: string; name: string; role: 'owner' } | { kind: 'guest'; id: string; name: string; role: 'colleague' | 'visitor' };

/**
 * read: look at it. detail: read what is behind it — documents, code, accounts, the record — which is for those who
 * work here, not for a visitor. work: change it, or reach into a machine. admin: run the office.
 */
export type Need = 'read' | 'detail' | 'work' | 'admin';

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
  // One's own character (docs/CHARACTER.md): everybody who comes in has one, visitors too — and only their own.
  rule('GET', '/me/character', 'read'),
  rule('PUT', '/me/character', 'read'),
  rule('DELETE', '/me/character', 'read'),
  rule('POST', '/logout', 'read'),
  rule('GET', '/state', 'read'),
  rule('GET', '/people', 'read'),
  rule('GET', '/people/assignable', 'work'),
  rule('GET', '/roles', 'read'),
  rule('GET', '/events', 'read'),
  rule('GET', '/performance', 'detail'),
  rule('GET', '/layout/capacity', 'read'),
  rule('GET', '/radio/now', 'read'),
  // The hi-fi plays for the whole office: everyone hears what is on; switching a station on or off is for those who work here.
  rule('GET', '/radio', 'read'),
  // The arcade: everyone who is in may play what is on the shelf; bringing a game and taking one off is for those who work here.
  rule('GET', '/arcade/games', 'read'),
  rule('GET', '/arcade/games/:id/rom', 'read'),
  rule('POST', '/arcade/games', 'work'),
  rule('POST', '/arcade/games/:id/data', 'work'),
  rule('DELETE', '/arcade/games/:id', 'work'),
  rule('POST', '/radio/play', 'work'),
  rule('POST', '/radio/stop', 'work'),
  // How much of each Claude account is used (the clocks): for those who work here. Whose account it is, is told only to those who may work on that machine.
  rule('GET', '/usage', 'detail'),
  // ── looking closer at one thing ──
  rule('GET', '/employees/:id/docs', 'detail', path('employee')),
  rule('GET', '/employees/:id/docs/file', 'detail', path('employee')),
  rule('GET', '/employees/:id/git', 'detail', path('employee')),
  rule('GET', '/employees/:id/xp', 'read', path('employee')),
  // Talk's whole conversation, and searching it (talk-history.ts): whoever may read the employee in detail.
  rule('GET', '/employees/:id/talk', 'detail', path('employee')),
  rule('POST', '/employees/:id/talk/search', 'detail', path('employee')),
  rule('GET', '/tasks/:id/git', 'detail', path('task')),
  // Files on a task: whoever works here and may see the task may open them; whoever may work with it may add and remove them.
  rule('GET', '/tasks/:id/attachments/:id', 'detail', path('task')),
  rule('POST', '/tasks/:id/attachments/:id/page', 'detail', path('task')),
  rule('GET', '/projects/:id/integration', 'detail', path('project')),
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
  // Taking a shared employee among one's own, and giving them back: whoever works here (which one, the route checks).
  rule('POST', '/employees/:id/keep', 'work', path('employee')),
  // Moving an employee to another machine with their folder and conversation (docs/MOVE.md): work on them, and on the machine they go to.
  rule('POST', '/employees/:id/move/plan', 'work', path('employee'), inBody('host', 'to')),
  rule('POST', '/employees/:id/move', 'work', path('employee'), inBody('host', 'to')),
  rule('POST', '/employees/:id/move/dismiss', 'work', path('employee')),
  rule('POST', '/employees/:id/give-back', 'work', path('employee')),
  rule('POST', '/employees/:id/start', 'work', path('employee')),
  rule('POST', '/employees/:id/stop', 'work', path('employee')),
  rule('POST', '/employees/:id/pause', 'work', path('employee')),
  rule('POST', '/employees/:id/resume', 'work', path('employee')),
  rule('POST', '/employees/:id/message', 'work', path('employee')),
  // A goal (like Claude Code's /goal): whoever may give the employee work. Its command to check by runs on their
  // machine as a project's verification command does — which the same people may set.
  rule('PUT', '/employees/:id/goal', 'work', path('employee')),
  rule('DELETE', '/employees/:id/goal', 'work', path('employee')),
  // Files that go with a message: whoever may talk to the employee sends them, and sees them in the conversation.
  rule('POST', '/employees/:id/files', 'work', path('employee')),
  rule('POST', '/employees/:id/files/:id/data', 'work', path('employee')),
  rule('GET', '/employees/:id/files/:id', 'work', path('employee')),
  rule('POST', '/employees/:id/report', 'work', path('employee')),
  rule('GET', '/employees/:id/telegram', 'work', path('employee')),
  rule('PUT', '/employees/:id/telegram', 'work', path('employee')),
  rule('PATCH', '/employees/:id/telegram', 'work', path('employee')),
  rule('DELETE', '/employees/:id/telegram', 'work', path('employee')),
  rule('POST', '/employees/:id/telegram/pair', 'work', path('employee')),
  rule('POST', '/employees/:id/telegram/check', 'work', path('employee')),
  rule('DELETE', '/employees/:id/telegram/people/:id', 'work', path('employee')),
  rule('PATCH', '/employees/:id/telegram/groups/:id', 'work', path('employee')),
  rule('DELETE', '/employees/:id/telegram/groups/:id', 'work', path('employee')),
  // Routines: standing instructions repeated for one employee. Whoever may work with the employee may set them.
  rule('GET', '/routines', 'detail'),
  rule('POST', '/routines', 'work', inBody('employee', 'employeeId')),
  rule('PATCH', '/routines/:id', 'work', path('routine')),
  rule('DELETE', '/routines/:id', 'work', path('routine')),
  rule('POST', '/routines/:id/run', 'work', path('routine')),
  rule('POST', '/sessions/attach', 'work', inBody('host', 'hostId'), inBody('employee', 'employeeId')),
  rule('POST', '/sessions/:id/adopt', 'work', path('session')),
  rule('POST', '/sessions/:id/bind', 'work', path('session'), inBody('employee', 'employeeId')),
  // ── reaching into a machine: its folders and what runs there ──
  rule('GET', '/hosts/:id/browse', 'work', path('host')),
  rule('POST', '/hosts/:id/folders', 'work', path('host')),
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
  // The central context (docs/CONTEXT.md): read by those who work here; written by owners and colleagues — which fact,
  // whose (a client's is an owner's; a project's or an employee's whoever may work on it), the route checks.
  rule('GET', '/context', 'detail'),
  rule('GET', '/context/pack/:id', 'detail', path('employee')),
  rule('POST', '/context/facts', 'work'),
  rule('PATCH', '/context/facts/:id', 'work'),
  rule('DELETE', '/context/facts/:id', 'work'),
  rule('POST', '/context/facts/:id/accept', 'work'),
  rule('POST', '/context/facts/:id/drop', 'work'),
  rule('POST', '/context/import', 'work'),
  // Whether what the office learned helped. Counted, for anyone but an owner, only from what they may see (`outcomesScopeFor`).
  rule('GET', '/growth/outcomes', 'detail'),
  // What the office did by itself with what it learned; each entry is filtered like any other event.
  rule('GET', '/growth/log', 'detail'),
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
    if (!owner && !allowed(who, r.need, null)) return { ok: false, reason: who.role !== 'visitor' ? 'Only an owner of this office can do this.' : r.need === 'detail' ? 'You are visiting this office: this is for the people who work here.' : 'You are visiting this office: you can look, not change anything.' };
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

/** What of an event's data the scene needs to move people about: who went to whom, and how. Nothing that was said. */
const OUTLINE_DATA = ['fromEmployeeId', 'toEmployeeId', 'roundId', 'action', 'quiet'];

/** An event for a visitor: that it happened, when and to whom. Its line for the feed and what it carries are left out. */
function outline(e: OrchestratorEvent): OrchestratorEvent {
  const data: Record<string, unknown> = {};
  for (const k of OUTLINE_DATA) if (k in e.data) data[k] = e.data[k];
  return { ...e, source: { kind: e.source.kind }, correlationId: null, summary: '', data };
}

/** An event as this person may read it: whole, with only what is public in it, or not at all (null). */
export function eventFor(engine: Engine, who: Who, e: OrchestratorEvent): OrchestratorEvent | null {
  // An owner reads everything — except what is said in a room its member has closed.
  if (who.kind === 'owner') return closedTo(engine, who, memberOfEvent(engine, e)) ? null : e;
  // The Rent portal — its clients and what is said with them — is the owners'.
  if (e.type.startsWith('rent.') || (e.data && typeof e.data.rentClientId === 'string')) return null;
  const pub = FOREMAN_PUBLIC[e.type];
  if (pub) return { ...e, sessionId: null, taskId: null, projectId: null, ...pub(e) };
  if (!can(engine, who, 'read', memberOfEvent(engine, e))) return null;
  return who.role === 'visitor' ? outline(e) : e;
}

/**
 * A message is read by whoever may read the one it was sent to. When another employee sent it, also by whoever may
 * read that one — except that the foreman as sender hides nothing: what it tells an employee is that employee's.
 */
export function mayReadMessage(engine: Engine, who: Who, m: Message): boolean {
  // What a client of the Rent portal writes is the office's business with that client: the owners'.
  if (m.channel === 'rent' && who.kind !== 'owner') return false;
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

// ── what a visitor is sent ──
// A visitor is here to look at the office: who is in it, who works on what, how the shared work stands; they may watch
// the shared terminals (the owners' word). They are not sent what the office runs on (which Claude, which account, the
// machines, the folders), what is said in it (instructions, messages, questions, notifications, reports), what the
// work looks like inside (descriptions, evidence, branches) or what it costs. Left out here, on the server: a page
// that only hid these would still have handed them over.

const forVisitor = {
  host: (h: Host): Host => ({ id: h.id, name: h.name, status: h.status, info: null, resources: null, enrolledAt: h.enrolledAt, lastSeenAt: null, revokedAt: h.revokedAt, local: h.local, claudeAccounts: [], memberId: h.memberId ?? null, memberName: h.memberName ?? null, room: h.room ?? null, ownerId: h.ownerId ?? null, ownerName: h.ownerName ?? null }),
  // (`autonomy` has no empty value: a visitor's page does not show it, and what is sent says nothing about the real one.)
  employee: (e: Employee): Employee => ({ ...e, model: null, effort: null, claudeConfigDir: null, workingDir: null, instructions: '', allowedTools: [], disallowedTools: [], autonomy: 'standard', captureOnboarded: [], captureSkills: [], keptBy: null, hiredBy: null, goal: null, moving: e.moving ? { ...e.moving, by: '', error: null } : null }),
  session: (s: AgentSession): AgentSession => ({ ...s, launchId: null, tmuxSession: '', tmuxPane: null, cwd: '', repoRoot: null, branch: null, claudeSessionId: null, codexThreadId: null, permissionMode: null, claudeConfigDir: null, saying: null, model: null, effort: null, pid: null, usage: null, exitReason: null }),
  project: (p: Project): Project => ({ id: p.id, name: p.name, description: p.description, goals: '', requirements: '', docs: '', hostId: p.hostId, repoPath: null, baseBranch: '', integrationBranch: '', workspace: p.workspace, ownerEmployeeId: p.ownerEmployeeId, verifyCommand: null, verifyTimeoutSec: 0, extraRepos: [], dependsOn: p.dependsOn ?? [], color: p.color, status: p.status, policy: { ...p.policy, allow: [], deny: [], highRiskPatterns: [] }, milestones: p.milestones, deliveredAt: p.deliveredAt, createdAt: p.createdAt }),
  // Named field by field, unlike the others: a task is where the work is talked about, and what it is given later
  // (as its conversation was) must not reach a visitor just because nobody thought of it here.
  task: (t: Task): Task => ({
    id: t.id, key: t.key, projectId: t.projectId, title: t.title, kind: t.kind, priority: t.priority, status: t.status, assigneeId: t.assigneeId, roleHint: null, dependsOn: t.dependsOn,
    requiresReview: t.requiresReview, reviewerId: t.reviewerId, reviewOf: t.reviewOf, released: t.released, nudges: 0, attempts: t.attempts, delivery: t.delivery,
    createdAt: t.createdAt, updatedAt: t.updatedAt, startedAt: t.startedAt, completedAt: t.completedAt,
    description: '', acceptance: '', branch: null, worktree: null, baseSha: null, verifyCommand: null, blockedReason: null, createdBy: '',
    friction: { failedVerifications: 0, reviewRejections: 0, mergeConflicts: 0, blockers: 0, questions: 0, denials: 0 },
    progress: { percent: t.progress?.percent ?? null, note: null, ts: t.progress?.ts ?? null },
    evidence: { summary: null, reportedTests: null, commits: [], filesChanged: [], diffStat: null, verification: null, review: null, merge: null },
    history: [],
  }),
  meeting: (m: Meeting): Meeting => ({ ...m, context: '', contributions: [], decisionDoc: null, generatedTaskIds: [] }),
  settings: (s: OwnerSettings): OwnerSettings => ({ ...s, autoAsksHighRisk: true, unrestrictedAsksHighRisk: true, lastSeenAt: null }),
};

/** Kinds of things a visitor is not sent at all: what is said, asked, reported and learned in the office. */
const NOT_FOR_VISITORS = new Set<EntityKind>(['question', 'message', 'collab', 'notification', 'artifact', 'lesson', 'improvement', 'performance', 'routine']);

/**
 * One thing of the office as this person is sent it: as it is, with only what a visitor may know of it, or not at all
 * (null). Those who work here get it as it is — what of a member's own computer is kept from them is decided for
 * events, messages, questions and routines by the functions above. Taking a thing away is told to everyone.
 */
export function shownTo<T>(engine: Engine, who: Who, kind: EntityKind, data: T, op: 'upsert' | 'remove' = 'upsert'): T | null {
  if (who.role !== 'visitor' || op === 'remove') return data;
  if (NOT_FOR_VISITORS.has(kind)) return null;
  const d = data as unknown as { id: string };
  switch (kind) {
    case 'host':
      return forVisitor.host(d as unknown as Host) as unknown as T;
    case 'employee':
      return forVisitor.employee(d as unknown as Employee) as unknown as T;
    case 'session':
      return forVisitor.session(d as unknown as AgentSession) as unknown as T;
    // A member's own project and its tasks are theirs; everyone still sees their employees at work.
    case 'project':
      return memberOf(engine, 'project', d.id) ? null : (forVisitor.project(d as unknown as Project) as unknown as T);
    case 'task':
      return memberOf(engine, 'task', d.id) ? null : (forVisitor.task(d as unknown as Task) as unknown as T);
    case 'meeting':
      return forVisitor.meeting(d as unknown as Meeting) as unknown as T;
    case 'settings':
      return forVisitor.settings(d as unknown as OwnerSettings) as unknown as T;
    default:
      return data;
  }
}

/** The office's state as this person may read it. */
export function stateFor(engine: Engine, who: Who, state: FullState): FullState {
  if (who.role === 'visitor') {
    const each = <T>(kind: EntityKind, rows: T[]): T[] => rows.map((r) => shownTo(engine, who, kind, r)).filter((r): r is T => r !== null);
    return {
      serverTime: state.serverTime,
      settings: shownTo(engine, who, 'settings', state.settings)!,
      layout: state.layout,
      hosts: each('host', state.hosts),
      employees: each('employee', state.employees),
      sessions: each('session', state.sessions),
      projects: each('project', state.projects),
      tasks: each('task', state.tasks),
      questions: [],
      messages: [],
      collabs: [],
      notifications: [],
      meetings: each('meeting', state.meetings),
      artifacts: [],
      milestones: state.milestones,
      company: state.company,
      lessons: [],
      improvements: [],
      performance: [],
      routines: [],
      events: state.events.map((e) => eventFor(engine, who, e)).filter((e): e is OrchestratorEvent => !!e),
    };
  }
  // A notification addressed to some people (an employee's `message_person`) is in their state only.
  if (state.notifications?.some((n) => n.for?.length)) state = { ...state, notifications: state.notifications.filter((n) => notificationFor(n, { id: who.id, owner: who.kind === 'owner' })) };
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
