/**
 * Rent: employees the office rents out (`docs/RENT.md`).
 *
 * A client is not a member. They never come into the office: they get a link, set a password and talk to the
 * employees they rent on the Rent portal at the office's address — a chat, one conversation per employee. The office
 * keeps the line between the two worlds here:
 *
 *   - **Conversations apart.** What a client writes reaches the employee's real session as a message from the client
 *     (`Message.channel: 'rent'`), and what the employee says at the end of that turn goes back to that client's
 *     conversation — not to the owner's Talk. The owner's own conversation stays the owner's. The employee is one session
 *     and knows all of it; each person sees only their own conversation (the owner can read the client's in Access → Rent).
 *   - **A wall between employees.** A rented employee talks to and works with only the other employees the same client
 *     rents (with teamwork on) — and nobody else in the office reaches them, but the foreman (`reaches`).
 *   - **A fence on their machine.** They reach only their own folder and their co-rented colleagues' folders, and run
 *     commands, change files and use the web only as far as the owner allows (`fenceFor` → `LaunchSpec.fence`, enforced
 *     by the host agent on every tool call, and pushed live when a rental changes).
 *   - **The office's things stay the office's.** No vault, no long memory unless the owner allows it; no task board, no
 *     lessons, no hiring (the MCP tools a rented employee is given: `toolAllowed`).
 *
 * Which turn is a client's: the office notes what started each turn (`turnStarted`, from the prompt's marker or the
 * Stop-hook delivery), and the end of that turn carries the client (`clientOfTurn`).
 */
import { RENT_PERMS_DEFAULT, RENT_PERM_KEYS, newId, nowIso, truncate, type Employee, type OrchestratorEvent, type RentClient, type RentFence, type RentLine, type RentPerms, type Rental, type SaidFile } from '@orchestrator/contracts';
import { LEAD_ROLE } from '@orchestrator/contracts';
import { EngineError } from './core.ts';
import type { Engine } from './engine.ts';

const KV = 'rent.clients';
const chatKey = (clientId: string, employeeId: string) => `rent.chat.${clientId}.${employeeId}`;
/** A client's name cannot hold what would make it something else in a prompt or a page. */
const clean = (s: unknown, max: number): string =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0000-\u001f\u007f<>[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** What a client is told their employee is doing: a word of their own, never what the office calls it inside (no approvals, no tasks). */
export type RentDoing = 'thinking' | 'reading' | 'writing' | 'running' | 'researching' | 'waiting';
const DOING: Record<string, RentDoing> = { thinking: 'thinking', planning: 'thinking', reviewing: 'reading', reading: 'reading', coding: 'writing', debugging: 'writing', testing: 'running', running_command: 'running', waiting_command: 'running', researching: 'researching', delegating: 'thinking', needs_approval: 'waiting', waiting_answer: 'waiting', blocked: 'waiting' };

export const RENT_LIMITS = { name: 60, company: 80, note: 2000, text: 8000, lines: 3000, clients: 500, agents: 20, clientsPerEmployee: 20 };

/** The office's own tools a rented employee is given (beside those its permissions add). Anything new stays out until named here. */
const RENT_TOOLS = new Set([
  'get_current_task',
  'get_project_context',
  'report_status',
  'report_progress',
  'ask_boss',
  'wait_for_answer',
  // (It waits for nothing, so also on a rental that never waits for the office; the rate limit keeps it rare.)
  'message_person',
  // Their own clients only, on the portal (`write`).
  'message_client',
  'comment_on_task',
  'report_blocker',
  'complete_task',
  'submit_result',
  'request_review',
  'submit_review',
  'send_message',
  'request_collaboration',
  'respond_to_request',
  'wait_for_colleague',
  'check_messages',
  'set_goal',
  'goal_met',
  'get_team',
  'get_task',
  'wake_colleague',
  'meeting_contribute',
  'meeting_conclude',
  'get_context',
  'propose_context',
]);
/** The foreman's and a team lead's own tools: never a rented employee's (their handlers refuse other callers anyway). */
const FOREIGN_ROLE_TOOLS = /^(team_|office_overview$|look_at$|answer_question$|assign_task$|create_task$|tell_employee$|escalate_to_owner$|finish_round$)/;
/** Tools that go with a permission. */
const PERM_TOOLS: Record<string, keyof RentPerms> = { attach_file: 'files', vault_list: 'vault', vault_store: 'vault', vault_read: 'vault', recall: 'memory', remember: 'memory' };
/** Tools that reach another employee: given only with teamwork. */
const TEAM_TOOLS = new Set(['send_message', 'request_collaboration', 'respond_to_request', 'wait_for_colleague', 'wake_colleague', 'get_team']);

export function permsFrom(input: unknown, base: RentPerms = RENT_PERMS_DEFAULT): RentPerms {
  const out = { ...base };
  if (input && typeof input === 'object') for (const k of RENT_PERM_KEYS) if (typeof (input as Record<string, unknown>)[k] === 'boolean') out[k] = (input as Record<string, boolean>)[k]!;
  return out;
}

export class Rent {
  private eng: Engine;
  private clients = new Map<string, RentClient>();
  /** What each employee's turn in hand answers: the client whose message began it, or null (the office). */
  private turns = new Map<string, string | null>();
  /** Told when a line is added to a conversation (the portal asks again; this is for whoever listens live). */
  onLine: (line: RentLine) => void = () => undefined;

  constructor(eng: Engine) {
    this.eng = eng;
    for (const c of eng.core.store.kvGet<RentClient[]>(KV, [])) {
      // Rentals made before "anywhere" and "never waits" existed: the owner who switched everything on meant everything
      // (their word of 2026-11-16: "what I allowed it may do — the server and all the rest — and the client must not
      // wait"); anybody else's rental keeps its fence and the office's approvals.
      // So too "office work" (the same day: a project manager rented out could no longer give its team work — "it will not
      // do things it could before"): taken on where every other switch was on.
      for (const r of c.rentals) {
        if (r.perms.anywhere !== undefined && r.perms.autonomous !== undefined && r.perms.office !== undefined) continue;
        const all = (['commands', 'edit', 'web', 'teamwork', 'files', 'vault', 'memory'] as const).every((k) => r.perms[k]);
        const anywhere = r.perms.anywhere ?? all;
        const autonomous = r.perms.autonomous ?? all;
        r.perms = { ...RENT_PERMS_DEFAULT, ...r.perms, anywhere, autonomous, office: r.perms.office ?? (all && anywhere && autonomous) };
      }
      this.clients.set(c.id, c);
    }
  }

  private get core() {
    return this.eng.core;
  }

  start(): void {
    this.core.bus.on('event', (e) => this.onEvent(e));
    // What a rented employee's machine holds may be from before this start (or before a rental changed): sent again.
    setTimeout(() => this.pushFences(this.list().filter((c) => !c.revokedAt).flatMap((c) => c.rentals.map((r) => r.employeeId))), 3000).unref?.();
    // A rented employee's folder moved, or a colleague's did: their fences follow.
    this.core.bus.on('entity', (kind, op, data) => {
      if (kind === 'employee' && op === 'upsert' && this.rentalOf((data as Employee).id)) this.pushFences(this.groupOf((data as Employee).id));
      // A machine is back (a member's own computer connected again): rented employees there whom a client wrote to meanwhile start.
      if (kind === 'host' && op === 'upsert' && (data as { status?: string }).status === 'online') {
        const hostId = (data as { id: string }).id;
        this.wakeWaiting(hostId);
        // (Its agent may have been updated, or kept an older fence while it was away: it is told the fences as they are now.)
        this.pushFences(this.list().filter((c) => !c.revokedAt).flatMap((c) => c.rentals.map((r) => r.employeeId)).filter((id) => this.core.employees.get(id)?.hostId === hostId));
      }
    });
  }

  private save(): void {
    this.core.store.kvSet(KV, [...this.clients.values()]);
  }

  // ───────────── who rents whom ─────────────

  list(): RentClient[] {
    return [...this.clients.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): RentClient | undefined {
    return this.clients.get(id);
  }

  /** A client who is still a client. */
  active(id: string | null | undefined): RentClient | null {
    const c = id ? this.clients.get(id) : undefined;
    return c && !c.revokedAt ? c : null;
  }

  byName(name: string): RentClient | undefined {
    const n = clean(name, RENT_LIMITS.name).toLowerCase();
    return n ? this.list().find((c) => !c.revokedAt && c.name.toLowerCase() === n) : undefined;
  }

  /** Every client renting this employee now, and on what terms (one employee may be rented to several at once). */
  rentalsOf(employeeId: string | null | undefined): Array<{ client: RentClient; rental: Rental }> {
    if (!employeeId) return [];
    const out: Array<{ client: RentClient; rental: Rental }> = [];
    for (const client of this.clients.values()) {
      if (client.revokedAt) continue;
      const rental = client.rentals.find((r) => r.employeeId === employeeId);
      if (rental) out.push({ client, rental });
    }
    return out;
  }

  /** The first client renting this employee (for words that name one), or null. */
  rentalOf(employeeId: string | null | undefined): { client: RentClient; rental: Rental } | null {
    return this.rentalsOf(employeeId)[0] ?? null;
  }

  /** This client's rental of this employee, if they rent them. */
  rentalBy(clientId: string, employeeId: string): Rental | null {
    return this.active(clientId)?.rentals.find((r) => r.employeeId === employeeId) ?? null;
  }

  /**
   * What a rented employee may do — one session, whoever it answers: the widest of the switches its clients' rentals
   * give (a switch is on if any of them has it on). Null: nobody rents them.
   */
  perms(employeeId: string | null | undefined): RentPerms | null {
    const all = this.rentalsOf(employeeId);
    if (!all.length) return null;
    const out = { ...all[0]!.rental.perms };
    for (const { rental } of all.slice(1)) for (const k of RENT_PERM_KEYS) out[k] = out[k] || rental.perms[k];
    return out;
  }

  /** The names of the clients renting this employee. */
  clientNames(employeeId: string): string {
    return this.rentalsOf(employeeId).map((r) => r.client.name).join(', ');
  }

  isRented(employeeId: string | null | undefined): boolean {
    return this.rentalsOf(employeeId).length > 0;
  }

  /** Rented and walled in with the clients' other employees (not let do office work): kept out of the office's work. */
  isWalled(employeeId: string | null | undefined): boolean {
    const p = this.perms(employeeId);
    return !!p && !p.office;
  }

  /** The employees one client rents (who still exist). */
  agentsOf(client: RentClient): Employee[] {
    return client.rentals.map((r) => this.core.employees.get(r.employeeId)).filter((e): e is Employee => !!e && !e.archived);
  }

  /** This employee and everyone their clients rent (for fences, which depend on each other's folders). */
  private groupOf(employeeId: string): string[] {
    return [...new Set([employeeId, ...this.rentalsOf(employeeId).flatMap((r) => r.client.rentals.map((x) => x.employeeId))])];
  }

  /**
   * Can this employee be rented by this person (`by`: the member's id, 'owner' for the office's own owner): someone who
   * does the work, on one of the office's machines — or on that person's own computer, where they work while it is
   * connected. Another member's own employees are that member's to rent, not anybody else's.
   */
  rentable(e: Employee, by: string | null, clientId: string | null = null): string | null {
    if (e.archived) return `${e.name} is archived.`;
    if (e.roleKey === 'foreman') return `${e.name} is the foreman: it supervises the office and is not rented out.`;
    if (e.roleKey === LEAD_ROLE) return `${e.name} is a member's team lead.`;
    const member = this.eng.hosts.memberOfHost(e.hostId);
    if (member && member !== by) return `${e.name} works on ${this.core.hosts.get(e.hostId ?? '')?.memberName ?? 'a member'}'s own computer: only they can rent them out.`;
    // Their machine must be able to keep them to their folders; one that says nothing is an agent from before Rent.
    const info = this.core.hosts.get(e.hostId ?? '')?.info;
    if (member && info && !info.rentFence) return `${e.name}'s computer runs an Orchestrator too old to keep a rented employee to their folders: update the app there first.`;
    if (e.selfDriven) return `${e.name} is somebody's own session, not an employee the office runs.`;
    // Several clients may rent the same employee at once; one client rents them once.
    if (clientId && this.rentalBy(clientId, e.id)) return `${e.name} is rented to ${this.get(clientId)?.name ?? 'this client'} already.`;
    if (this.rentalsOf(e.id).length >= RENT_LIMITS.clientsPerEmployee) return `${e.name} is rented to ${RENT_LIMITS.clientsPerEmployee} clients already.`;
    return null;
  }

  create(input: { name?: unknown; company?: unknown; note?: unknown; employeeIds?: unknown; perms?: unknown }, actor: string, taken: (name: string) => boolean, by: string | null = null): RentClient {
    const name = clean(input.name, RENT_LIMITS.name);
    if (!name) throw new EngineError('a client needs a name');
    if (this.byName(name) || taken(name)) throw new EngineError(`the name "${name}" is taken: everybody who signs in at the office's address needs a name of their own`);
    if (this.list().filter((c) => !c.revokedAt).length >= RENT_LIMITS.clients) throw new EngineError('there are as many clients as the office keeps');
    const ids = Array.isArray(input.employeeIds) ? [...new Set(input.employeeIds.map(String))] : [];
    const perms = permsFrom(input.perms);
    for (const id of ids) {
      const e = this.core.employees.require(id);
      const no = this.rentable(e, by);
      if (no) throw new EngineError(no);
    }
    const now = nowIso();
    const client: RentClient = { id: newId(), name, company: clean(input.company, RENT_LIMITS.company) || null, note: String(input.note ?? '').slice(0, RENT_LIMITS.note), createdAt: now, createdBy: actor, revokedAt: null, lastSeenAt: null, rentals: ids.map((employeeId) => ({ employeeId, since: now, perms: { ...perms } })) };
    this.clients.set(client.id, client);
    this.save();
    this.core.audit(actor, 'rent.client_created', client.id, { name, employees: ids.map((id) => this.core.employees.get(id)?.name) });
    this.changed(client, ids);
    return client;
  }

  update(id: string, patch: { name?: unknown; company?: unknown; note?: unknown }, actor: string, taken: (name: string) => boolean): RentClient {
    const client = this.require(id);
    if (patch.name !== undefined) {
      const name = clean(patch.name, RENT_LIMITS.name);
      if (!name) throw new EngineError('a client needs a name');
      if (name.toLowerCase() !== client.name.toLowerCase() && (this.byName(name) || taken(name))) throw new EngineError(`the name "${name}" is taken`);
      client.name = name;
    }
    if (patch.company !== undefined) client.company = clean(patch.company, RENT_LIMITS.company) || null;
    if (patch.note !== undefined) client.note = String(patch.note ?? '').slice(0, RENT_LIMITS.note);
    this.save();
    this.core.audit(actor, 'rent.client_changed', id, { name: client.name });
    this.changed(client, []);
    return client;
  }

  rent(id: string, employeeId: string, perms: unknown, actor: string, by: string | null = null): RentClient {
    const client = this.require(id);
    if (client.rentals.length >= RENT_LIMITS.agents) throw new EngineError(`a client rents at most ${RENT_LIMITS.agents} employees`);
    const e = this.core.employees.require(employeeId);
    const no = this.rentable(e, by, client.id);
    if (no) throw new EngineError(no);
    client.rentals.push({ employeeId, since: nowIso(), perms: permsFrom(perms) });
    this.save();
    this.core.audit(actor, 'rent.rented', id, { client: client.name, employee: e.name });
    this.changed(client, client.rentals.map((r) => r.employeeId));
    return client;
  }

  setPerms(id: string, employeeId: string, perms: unknown, actor: string): RentClient {
    const client = this.require(id);
    const rental = client.rentals.find((r) => r.employeeId === employeeId);
    if (!rental) throw new EngineError('that employee is not rented to this client', 404);
    rental.perms = permsFrom(perms, rental.perms);
    this.save();
    this.core.audit(actor, 'rent.perms_changed', id, { client: client.name, employee: this.core.employees.get(employeeId)?.name, perms: rental.perms });
    this.changed(client, client.rentals.map((r) => r.employeeId));
    return client;
  }

  /** The employee is no longer rented to this client: they are the office's again, fence and wall gone. */
  release(id: string, employeeId: string, actor: string): RentClient {
    const client = this.require(id);
    const before = client.rentals.length;
    client.rentals = client.rentals.filter((r) => r.employeeId !== employeeId);
    if (client.rentals.length === before) throw new EngineError('that employee is not rented to this client', 404);
    this.save();
    this.core.audit(actor, 'rent.released', id, { client: client.name, employee: this.core.employees.get(employeeId)?.name });
    this.changed(client, [employeeId, ...client.rentals.map((r) => r.employeeId)]);
    return client;
  }

  /** The client is no longer a client: every rental ends. Their conversations stay for the owner to read. */
  revoke(id: string, actor: string): RentClient {
    const client = this.require(id);
    if (client.revokedAt) return client;
    const ids = client.rentals.map((r) => r.employeeId);
    client.revokedAt = nowIso();
    this.save();
    this.core.audit(actor, 'rent.client_revoked', id, { name: client.name });
    this.changed(client, ids);
    return client;
  }

  seen(id: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    const now = Date.now();
    if (c.lastSeenAt && now - Date.parse(c.lastSeenAt) < 60_000) return;
    c.lastSeenAt = new Date(now).toISOString();
    this.save();
  }

  private require(id: string): RentClient {
    const c = this.clients.get(id);
    if (!c) throw new EngineError('unknown client', 404);
    return c;
  }

  /** A rental changed: the fences of those it touches follow at once, and the office's windows are told. */
  private changed(client: RentClient, employeeIds: string[]): void {
    this.pushFences(employeeIds);
    this.core.event({ type: 'rent.changed', source: 'server', summary: `Rent: ${client.name}`, data: { clientId: client.id, quiet: true } });
  }

  // ───────────── the wall between employees ─────────────

  /**
   * May `from` reach `to` (a message, a request, waiting for them, waking them)? Between two employees nobody rents:
   * as ever. A rented one reaches only those the same client rents, both with teamwork on; nobody else reaches a rented
   * one — but the foreman, which supervises the office for the owner.
   */
  reaches(from: Employee, to: Employee): boolean {
    // (One let do office work is not walled in: as far as reaching goes, they are the office's.)
    if (!this.isWalled(from.id) && !this.isWalled(to.id)) return true;
    if (!this.isRented(from.id) && from.roleKey === 'foreman') return true;
    // Walled: only colleagues a client of theirs rents too, with teamwork on in both rentals.
    return this.rentalsOf(from.id).some(({ client, rental }) => rental.perms.teamwork && !!this.rentalBy(client.id, to.id)?.perms.teamwork);
  }

  /** Why `from` cannot reach `to`, in words for `from`; null when it can. */
  wall(from: Employee, to: Employee): string | null {
    if (this.reaches(from, to)) return null;
    const a = this.rentalOf(from.id);
    if (a) return `${to.name} is not one of the colleagues you work with for ${this.clientNames(from.id)}: while you are rented you work only with them${this.perms(from.id)?.teamwork ? '' : ' — and the owner has not let you work with other employees at all'}. Nothing was sent.`;
    return `${to.name} is rented to a client and works only with that client's other employees. Nothing was sent.`;
  }

  /** May a rented employee use this tool of the office's (null: not rented, everything as usual). */
  toolAllowed(employee: Employee, tool: string): boolean | null {
    const p = this.perms(employee.id);
    if (!p) return null;
    const perm = PERM_TOOLS[tool];
    if (perm) return p[perm];
    if (TEAM_TOOLS.has(tool) && !p.teamwork && !p.office) return false;
    // Never waiting for the office: nothing is asked of the owner — the client is asked, in the conversation.
    if (p.autonomous && (tool === 'ask_boss' || tool === 'wait_for_answer')) return false;
    // Office work: the office's tools as before (the board, handing work out, lessons) — but the foreman's and a lead's.
    if (p.office) return !FOREIGN_ROLE_TOOLS.test(tool);
    return RENT_TOOLS.has(tool);
  }

  // ───────────── the fence on their machine ─────────────

  fenceFor(employee: Employee, cwd?: string | null): RentFence | null {
    const p = this.perms(employee.id);
    if (!p) return null;
    const own = [employee.workingDir, cwd].filter((d): d is string => !!d);
    // The colleagues a client of theirs rents too, with teamwork on in both rentals — and only where they are: on the same machine.
    const peers = this.rentalsOf(employee.id).flatMap(({ client, rental }) =>
      rental.perms.teamwork ? this.agentsOf(client).filter((e) => e.id !== employee.id && e.hostId === employee.hostId && !!this.rentalBy(client.id, e.id)?.perms.teamwork).map((e) => e.workingDir).filter((d): d is string => !!d) : [],
    );
    return { roots: [...new Set([...own, ...peers])], commands: p.commands, edit: p.edit, web: p.web, ...(p.anywhere ? { anywhere: true } : {}), ...(p.autonomous ? { autonomous: true } : {}), client: this.clientNames(employee.id) };
  }

  /** Claude Code's own rules for a rented employee, beside the fence: the tools they are not allowed are not there at all. */
  denyRulesFor(employee: Employee): string[] {
    const p = this.perms(employee.id);
    if (!p) return [];
    return [...(p.commands ? [] : ['Bash']), ...(p.edit ? [] : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']), ...(p.web ? [] : ['WebFetch', 'WebSearch'])];
  }

  /** Does this rented employee never wait for the office (approvals, the high-risk hold, questions)? */
  autonomous(employeeId: string | null | undefined): boolean {
    return !!this.perms(employeeId)?.autonomous;
  }

  /** May a rented employee who never waits run this tool without an approval? Only what their switches allow. */
  mayRunUnasked(employeeId: string | null | undefined, tool: string): boolean {
    const p = this.perms(employeeId);
    if (!p || !p.autonomous) return false;
    if (tool === 'Bash') return p.commands;
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return p.edit;
    if (tool === 'WebFetch' || tool === 'WebSearch') return p.web;
    return true;
  }

  /** The co-rented colleagues' folders, so that Claude Code lets them work there. */
  extraDirsFor(employee: Employee): string[] {
    const f = this.fenceFor(employee);
    return f ? f.roots.filter((d) => d !== employee.workingDir) : [];
  }

  /** Send the fence of each of these employees to the machine their session runs on, as it is now. */
  pushFences(employeeIds: string[]): void {
    for (const id of new Set(employeeIds)) {
      const e = this.core.employees.get(id);
      const s = this.core.runningSessionOf(id);
      if (!e || !s || !this.core.agents.isOnline(s.hostId)) continue;
      const fence = this.fenceFor(e, s.cwd);
      void this.core.agents.rpc(s.hostId, { method: 'session.fence', params: { sessionId: s.id, fence } }, 8000).catch((err) => this.core.log('warn', `the fence of ${e.name} did not reach their machine: ${(err as Error).message}`));
    }
  }

  // ───────────── conversations ─────────────

  lines(clientId: string, employeeId: string): RentLine[] {
    return this.core.store.kvGet<RentLine[]>(chatKey(clientId, employeeId), []);
  }

  private add(line: Omit<RentLine, 'id' | 'ts'> & { ts?: string }): RentLine {
    const full: RentLine = { id: newId(), ts: line.ts ?? nowIso(), ...line } as RentLine;
    const key = chatKey(full.clientId, full.employeeId);
    this.core.store.kvSet(key, [...this.core.store.kvGet<RentLine[]>(key, []), full].slice(-RENT_LIMITS.lines));
    this.onLine(full);
    return full;
  }

  /** The body the employee is given: who writes, what, and how to answer — the client sees only the reply. */
  private body(client: RentClient, employee: Employee, rental: Rental, text: string): string {
    const peers = rental.perms.teamwork ? this.agentsOf(client).filter((e) => e.id !== employee.id && !!this.rentalBy(client.id, e.id)?.perms.teamwork) : [];
    // Others rent them too: each client's conversation is that client's.
    const others = this.rentalsOf(employee.id).filter((r) => r.client.id !== client.id).map((r) => r.client.name);
    // (What they may do is one session's: the widest of their clients' switches — the files of this conversation are this client's.)
    const eff = this.perms(employee.id) ?? rental.perms;
    const who = `${client.name}${client.company ? ` (${client.company})` : ''}`;
    const can = [eff.commands ? null : 'run no commands', eff.edit ? null : 'change no files', eff.web ? null : 'use no web'].filter(Boolean);
    return [
      `On the Rent portal, ${who} writes — a client of the office who rents you:`,
      text,
      '',
      `(Your reply goes to ${client.name} on the portal; they see only what you reply${rental.perms.files ? ' and the files you give them with attach_file' : ''}, nothing of the office. ` +
        (eff.anywhere
          ? `You may work anywhere on this machine and on the servers the work needs, as far as the owner allows (${[eff.commands ? 'commands' : null, eff.edit ? 'changing files' : null, eff.web ? 'the web' : null].filter(Boolean).join(', ') || 'reading only'})`
          : `While rented you work only in your own folder${employee.workingDir ? ` (${employee.workingDir})` : ''}`) +
        (peers.length ? `; ${client.name} rents ${peers.map((e) => `${e.name}${!eff.anywhere && e.hostId === employee.hostId && e.workingDir ? ` (whose folder ${e.workingDir} you may use too)` : ''}`).join(', ')} too — coordinate with them with send_message` : '') +
        (can.length ? `; the owner set that you ${can.join(', ')}` : '') +
        '. ' +
        (eff.office ? 'You go on working with the office as before — the task board and every colleague — for this client as for anyone. ' : '') +
        (eff.autonomous
          ? `Nothing you do waits for the office: the owner has given you leave for all of it, so decide yourself and go on — do not ask the boss. What is ${client.name}'s to decide, ask ${client.name} in your reply. `
          : '') +
        (others.length ? `Other clients rent you too (${others.join(', ')}): what each of them tells you is theirs — do not pass it on to ${client.name}, nor ${client.name}'s to them. ` : '') +
        'What the boss tells you in the office is not for clients unless the boss says so. ' +
        `To write to ${client.name} later, not in answer to them — the boss asks you to tell or ask them something, or an answer they wait for comes in — use message_client: it is in their conversation at once, without waiting for them to write.)`,
      ...((facts) => (facts.length ? ['', `What the office knows about ${client.name} (the central context):`, ...facts.map((f) => `- **${f.title}** — ${f.text}`)] : []))(this.eng.context.clientFacts(client.id).filter((f) => f.always)),
    ].join('\n');
  }

  /**
   * A client writes to an employee they rent. Their session is brought in if nobody is at the desk. The line stands in
   * the conversation whatever happens next; when it cannot be handed over, the office says so under it.
   */
  async say(clientId: string, employeeId: string, text: unknown, fileIds: string[], by: string): Promise<RentLine> {
    const client = this.active(clientId);
    if (!client) throw new EngineError('this client is no longer a client of the office', 403);
    const rental = client.rentals.find((r) => r.employeeId === employeeId);
    if (!rental) throw new EngineError('no such employee', 404);
    const employee = this.core.employees.require(employeeId);
    const words = String(text ?? '').replace(/\r\n/g, '\n').trim().slice(0, RENT_LIMITS.text);
    if (!words && !fileIds.length) throw new EngineError('write something');
    if (fileIds.length && !rental.perms.files) throw new EngineError('files cannot be sent to this employee');
    // Their machine is not connected (a member's own computer that is off): the words wait, and they get them when it is back.
    if (employee.hostId && !this.core.agents.isOnline(employee.hostId) && !this.core.runningSessionOf(employee.id)) {
      if (fileIds.length) throw new EngineError(`${employee.name} is away (their computer is not connected): send the files when they are back.`);
      const message = this.eng.comms.sendMessage({ from: { kind: 'owner', id: null, name: `${client.name} (a client who rents you)` }, toEmployeeId: employee.id, body: this.body(client, employee, rental, words), said: words, channel: 'rent', clientId });
      const line = this.add({ clientId, employeeId, from: 'client', text: words, messageId: message.id });
      this.add({ clientId, employeeId, from: 'note', text: `${employee.name} is away right now. They get this as soon as they are back.` });
      return line;
    }
    // Nobody at the desk: they are brought in, as the office's own window does when somebody talks to them.
    if (!this.core.runningSessionOf(employee.id) && !this.eng.sessions.present(employee.id)) {
      const why = !employee.hostId
        ? 'they have no machine to work on'
        : await Promise.resolve()
            .then(() => this.eng.sessions.start(employee.id, { resume: true, actor: `client:${client.name}` }))
            .then(
              () => null,
              (e: Error) => e.message,
            );
      if (why) {
        const line = this.add({ clientId, employeeId, from: 'client', text: words });
        this.add({ clientId, employeeId, from: 'note', text: `${employee.name} cannot start right now. The office has been told; try again a little later.` });
        this.core.log('warn', `rent: ${employee.name} could not start for ${client.name}: ${why}`);
        this.eng.comms.notify({ kind: 'info', severity: 'warning', title: `${employee.name} could not start for ${client.name}`, body: `A message from ${client.name} on the Rent portal is waiting: ${why}`, employeeId: employee.id });
        return line;
      }
    }
    const sent = await this.eng.saidFiles.deliver(employee, fileIds, by);
    const said = words || 'Look at this.';
    const message = this.eng.comms.sendMessage({
      from: { kind: 'owner', id: null, name: `${client.name} (a client who rents you)` },
      toEmployeeId: employee.id,
      body: this.body(client, employee, rental, said) + (sent.lines.length ? `\n\nFiles that go with this — open ${sent.lines.length === 1 ? 'it' : 'each'} with the Read tool before you answer:\n${sent.lines.join('\n')}` : ''),
      files: sent.files,
      said,
      channel: 'rent',
      clientId,
    });
    return this.add({ clientId, employeeId, from: 'client', text: words, messageId: message.id, ...(sent.files.length ? { files: sent.files } : {}) });
  }

  /**
   * A rented employee writes to a client of theirs, not in answer to them (`message_client`): the boss asked them to tell
   * or ask the client something, or news came that the client waits for (the boss's answer, a colleague's result). The
   * line stands in that client's conversation at once — the portal shows it, marked new, without the client writing
   * first. Throws in words for the employee when there is nobody to write to; nothing is written then.
   */
  write(employee: Employee, to: unknown, text: unknown): { client: RentClient; line: RentLine } {
    const words = String(text ?? '').replace(/\r\n/g, '\n').trim().slice(0, RENT_LIMITS.text);
    if (!words) throw new EngineError('Write the message in "message". Nothing was sent.');
    const mine = this.rentalsOf(employee.id).map((r) => r.client);
    if (!mine.length) throw new EngineError('No client rents you: there is nobody on the Rent portal to write to. For a person of the office use message_person; for an employee, send_message.');
    const plain = (x: string) => clean(x, 200).toLowerCase();
    const want = plain(String(to ?? '')).replace(/^@/, '');
    const exact = want ? mine.filter((c) => plain(c.name) === want || (!!c.company && plain(c.company) === want)) : [];
    const first = exact.length ? exact : want ? mine.filter((c) => plain(c.name).split(' ')[0] === want) : mine;
    if (first.length !== 1) {
      const names = mine.map((c) => c.name).join(', ');
      throw new EngineError(`${want ? (first.length ? `More than one client is called "${clean(to, 60)}"` : `No client of yours is called "${clean(to, 60)}"`) : 'Several clients rent you; say which one in "to"'}. You can write to: ${names}. Nothing was sent.`);
    }
    const client = first[0]!;
    // Answering that very client now: the reply goes to them anyway, and a second copy of it would only be noise.
    if (this.clientOfTurn(employee.id) === client.id) throw new EngineError(`You are answering ${client.name} right now: your reply goes to them on the portal by itself. Put it in your reply. Nothing was sent.`);
    const line = this.add({ clientId: client.id, employeeId: employee.id, from: 'agent', text: words });
    this.core.event({ type: 'rent.agent_wrote', source: 'mcp', summary: `${employee.name} wrote to ${client.name} on the Rent portal`, employeeId: employee.id, data: { clientId: client.id } });
    return { client, line };
  }

  /** Rented employees on this machine who have a client's words waiting and no session: started, so the words reach them. */
  private wakeWaiting(hostId: string): void {
    for (const client of this.clients.values()) {
      if (client.revokedAt) continue;
      for (const r of client.rentals) {
        const e = this.core.employees.get(r.employeeId);
        if (!e || e.hostId !== hostId || this.core.runningSessionOf(e.id) || this.eng.sessions.present(e.id)) continue;
        const waiting = !!this.core.messages.find((m) => m.toEmployeeId === e.id && m.channel === 'rent' && m.delivery.status === 'queued');
        if (!waiting) continue;
        void Promise.resolve()
          .then(() => this.eng.sessions.start(e.id, { resume: true, actor: `client:${client.name}` }))
          .catch((err: Error) => this.core.log('warn', `rent: ${e.name} could not start when their machine came back: ${err.message}`));
      }
    }
  }

  // ───────────── which turn is whose ─────────────

  /** A turn began with this message of the office's (null: a prompt that is not a message — a task, a person at the keyboard). */
  turnStarted(employeeId: string, messageId: string | null): void {
    const m = messageId ? this.core.messages.get(messageId) : undefined;
    this.turns.set(employeeId, m?.channel === 'rent' && m.clientId ? m.clientId : null);
  }

  /** The client whose message the employee's turn in hand answers, if it is one. */
  clientOfTurn(employeeId: string | null | undefined): string | null {
    return employeeId ? (this.turns.get(employeeId) ?? null) : null;
  }

  private onEvent(e: OrchestratorEvent): void {
    const clientId = typeof e.data?.rentClientId === 'string' ? e.data.rentClientId : null;
    if (!clientId || !e.employeeId) return;
    const client = this.active(clientId);
    if (!client || !client.rentals.some((r) => r.employeeId === e.employeeId)) return;
    if (e.type === 'agent.turn_finished') {
      const text = String(e.data.lastMessage ?? '').trim();
      if (text) this.add({ clientId, employeeId: e.employeeId, from: 'agent', text, ts: e.ts });
    } else if (e.type === 'agent.file_given' && e.data.file && !e.data.taskId) {
      const file = e.data.file as SaidFile;
      this.add({ clientId, employeeId: e.employeeId, from: 'agent', text: typeof e.data.caption === 'string' ? e.data.caption : '', files: [file], ts: e.ts });
    }
  }

  /** A file of a conversation, for the client of that conversation only: one the client sent, or one the employee gave them. */
  fileOf(clientId: string, employeeId: string, fileId: string): SaidFile | null {
    for (const line of this.lines(clientId, employeeId)) {
      const f = line.files?.find((x) => x.id === fileId);
      if (f) return f;
    }
    return null;
  }

  /** What the client is told about an employee they rent: who they are and what they are doing — nothing of the office. */
  agentView(e: Employee, rental: Rental): { id: string; name: string; title: string; appearance: Employee['appearance']; state: string; busy: boolean; files: boolean; since: string; offline: boolean; doing: RentDoing | null } {
    const s = this.core.runningSessionOf(e.id);
    // (Their machine not connected: a member's own computer that is off. They are away until it is back.)
    const offline = !!e.hostId && !this.core.agents.isOnline(e.hostId);
    const busy = !!s && (s.inTurn === true || ['thinking', 'reading', 'coding', 'testing', 'debugging', 'running_command', 'researching', 'planning', 'reviewing', 'delegating'].includes(s.activity));
    const state = !s ? 'away' : s.activity === 'paused' ? 'paused' : busy ? 'working' : 'available';
    return { id: e.id, name: e.name, title: e.title, appearance: e.appearance, state: offline ? 'away' : state, busy: !offline && busy, files: rental.perms.files, since: rental.since, offline, doing: !offline && s ? (DOING[s.activity] ?? (busy ? 'thinking' : null)) : null };
  }

  /** A short line for the owner's lists: who, what for, and the conversation's last word. */
  summary(client: RentClient): { lastLineAt: string | null; lines: number } {
    let last: string | null = null;
    let n = 0;
    for (const r of client.rentals) {
      const ls = this.lines(client.id, r.employeeId);
      n += ls.length;
      const t = ls[ls.length - 1]?.ts ?? null;
      if (t && (!last || t > last)) last = t;
    }
    return { lastLineAt: last, lines: n };
  }

  /** Cut for a prompt or a list, where a line could be long. */
  static short(text: string, n = 120): string {
    return truncate(text.replace(/\s+/g, ' '), n);
  }
}
