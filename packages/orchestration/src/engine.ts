import type { Artifact, Employee, FullState, OfficeLayout, Question, Project } from '@orchestrator/contracts';
import { matchRole, newId, nowIso, roleByKey, directsOthers } from '@orchestrator/contracts';
import type { McpServerOptions } from '@orchestrator/integrations';
import { TerminalGateway, type GatewayDeps } from '@orchestrator/terminal';
import { CommandCenter } from './commands.ts';
import { Comms } from './comms.ts';
import { Core, EngineError, type EngineOptions } from './core.ts';
import { Foreman } from './foreman.ts';
import { Lead } from './lead.ts';
import { SaidFiles } from './said-files.ts';
import { HookReceiver } from './hook-receiver.ts';
import { Improver } from './improve.ts';
import { Vault } from './vault.ts';
import { Attachments } from './attachments.ts';
import { Memory } from './memory.ts';
import { MeetingManager } from './meetings.ts';
import { buildMcpServer, type McpContext } from './mcp-tools.ts';
import { EmployeeRegistry, HostRegistry, SessionRegistry, type EmployeeInput } from './registry.ts';
import { Routines } from './routines.ts';
import { Sleeper } from './sleep.ts';
import { WorkLog } from './work-log.ts';
import { TaskManager } from './tasks.ts';
import { TaskTalk } from './task-talk.ts';
import { Waits } from './waits.ts';
import { Background } from './background.ts';
import { Goals } from './goals.ts';

/**
 * The orchestration engine: the single source of truth the 3D office renders.
 *
 *   hosts ─ sessions ─ employees      who exists and where they really run
 *   hooks ─ comms                     what they are doing, asking and being told
 *   tasks ─ meetings ─ commands       what work exists and how it moves
 *   foreman                           an employee who supervises the rest, in rounds
 *   routines ─ sleep                  what is repeated by the clock, and who rests meanwhile
 *   waits                             who cannot go on until a colleague has answered or finished
 *
 * Nothing in here knows about rendering.
 */
export class Engine {
  readonly core: Core;
  readonly hosts: HostRegistry;
  readonly employees: EmployeeRegistry;
  readonly sessions: SessionRegistry;
  readonly hooks: HookReceiver;
  readonly comms: Comms;
  readonly tasks: TaskManager;
  /** The conversation on a task: comments, questions the work waits for, sending back, parts (`docs/TASKS.md`). */
  readonly talk: TaskTalk;
  readonly meetings: MeetingManager;
  readonly commands: CommandCenter;
  readonly improver: Improver;
  readonly foreman: Foreman;
  /** Files that go with a message to an employee: a pasted screenshot, a document (said-files.ts). */
  readonly saidFiles: SaidFiles;
  /** Members' team leads: what one may see and do (lead.ts). */
  readonly lead: Lead;
  readonly routines: Routines;
  readonly sleeper: Sleeper;
  readonly work: WorkLog;
  readonly waits: Waits;
  readonly background: Background;
  readonly goals: Goals;
  readonly vault: Vault;
  readonly memory: Memory;
  readonly attachments: Attachments;
  readonly mcp: McpServerOptions<McpContext>;
  private housekeeping: NodeJS.Timeout | null = null;
  private accountsTimer: NodeJS.Timeout | null = null;

  constructor(opts: EngineOptions, gatewayDeps: Pick<GatewayDeps, 'send'>) {
    this.core = new Core(opts);
    this.hosts = new HostRegistry(this);
    this.employees = new EmployeeRegistry(this);
    this.sessions = new SessionRegistry(this);
    this.hooks = new HookReceiver(this);
    this.comms = new Comms(this);
    this.tasks = new TaskManager(this);
    this.talk = new TaskTalk(this);
    this.meetings = new MeetingManager(this);
    this.commands = new CommandCenter(this);
    this.improver = new Improver(this);
    this.foreman = new Foreman(this);
    this.lead = new Lead(this);
    this.routines = new Routines(this);
    this.sleeper = new Sleeper(this);
    this.work = new WorkLog(this);
    this.waits = new Waits(this);
    this.background = new Background(this);
    this.goals = new Goals(this);
    this.vault = new Vault(this.core, opts.vaultKeyFile ?? null);
    this.vault.onCaptureFailed = (why) =>
      void this.comms?.securityAlert({
        key: 'vault-capture',
        severity: 'warning',
        title: 'A credential could not be put into the vault',
        body: `Something that looks like a credential was written in the office and stays where it was written, because the vault did not take it: ${why}. Make room in the vault (Company → Vault) or see to its key; until then credentials in messages and tasks are not replaced by their names.`,
      });
    this.memory = new Memory(this, opts.memory ?? { bin: null, dir: null });
    this.attachments = new Attachments(this.core, this, opts.filesDir ?? null);
    // Beside the tasks' files, not among them: the sweep of each knows only its own.
    this.saidFiles = new SaidFiles(this.core, opts.filesDir ? `${opts.filesDir}-said` : null);
    // A task that is deleted takes its files with it.
    this.core.bus.on('entity', (kind, op, data) => {
      if (kind === 'task' && op === 'remove') this.attachments.dropTask(String((data as { id?: string })?.id ?? ''));
    });
    // What is worth remembering is filed as it happens: a task that is done, an answer that was given, a lesson in use, a meeting's decision.
    this.core.bus.on('entity', (kind, op, data) => {
      if (op !== 'upsert' || !this.memory.available()) return;
      if (kind === 'settings') return void this.memory.caughtUp();
      try {
        if (kind === 'task') this.memory.task(data);
        else if (kind === 'question') this.memory.answer(data);
        else if (kind === 'lesson') this.memory.lesson(data);
        else if (kind === 'meeting') this.memory.meeting(data);
      } catch (e) {
        this.core.log('warn', `long memory: ${(e as Error).message}`);
      }
    });
    this.core.gateway = new TerminalGateway({
      rpc: (hostId, rpc, timeoutMs) => this.core.agents.rpc(hostId, rpc, timeoutMs),
      locate: (sessionId) => {
        const s = this.core.sessions.get(sessionId);
        if (!s) return null;
        return { hostId: s.hostId, online: this.core.agents.isOnline(s.hostId), running: s.status === 'running' || s.status === 'starting' || s.status === 'exited' };
      },
      send: gatewayDeps.send,
      audit: (actor, action, target, detail) => this.core.audit(actor, action, target, detail),
      onControlChange: (sessionId, control, controllerId) => {
        const s = this.core.sessions.get(sessionId);
        if (!s || (s.control === control && s.controllerId === controllerId)) return;
        const before = s.control;
        s.control = control;
        s.controllerId = controllerId;
        this.core.put('session', s);
        const emp = this.core.employees.get(s.employeeId);
        const who = emp?.name ?? s.tmuxSession;
        if (control === 'HUMAN_CONTROLLED') {
          this.core.event({ type: 'terminal.control_acquired', source: 'owner', summary: `Boss took control of ${who}'s terminal`, sessionId, employeeId: s.employeeId, hostId: s.hostId, data: { controllerId } });
        } else if (before === 'HUMAN_CONTROLLED') {
          this.core.event({ type: 'terminal.control_released', source: 'owner', summary: `Boss returned control of ${who}'s terminal`, sessionId, employeeId: s.employeeId, hostId: s.hostId, data: {} });
          // Anything Orchestrator held back while the owner was typing can go out now.
          if (emp) this.comms.schedulePump(emp.id, 800);
        }
      },
      onInputBlocked: (sessionId) => {
        const s = this.core.sessions.get(sessionId);
        this.core.event({ type: 'terminal.input_blocked', source: 'server', summary: `Keystrokes ignored: ${this.core.employees.get(s?.employeeId)?.name ?? 'session'}'s terminal is being observed, not controlled`, sessionId, employeeId: s?.employeeId ?? null, data: { quiet: true } });
      },
    });
    this.mcp = buildMcpServer(this);
  }

  /** Reconstruct runtime state from the database after a (re)start. */
  start(): void {
    // Before anything is remembered or shown: credentials that stand in old records go to the vault.
    try {
      this.vault.sweep();
    } catch (e) {
      this.core.log('warn', `vault: ${(e as Error).message}`);
    }
    void this.memory.start();
    this.sessions.restore();
    const reseated = this.repairSeats();
    if (reseated) this.core.log('info', `${reseated} seat${reseated === 1 ? '' : 's'} that stood in a neighbouring table ${reseated === 1 ? 'was' : 'were'} moved to its own table`);
    const requeued = this.tasks.requeueFolderWaits();
    if (requeued) this.core.log('info', `${requeued} task${requeued === 1 ? '' : 's'} that waited for a shared folder ${requeued === 1 ? 'is' : 'are'} back in the queue`);
    const levelled = this.sessions.adoptThreeLevels();
    if (levelled) this.core.log('info', `${levelled} employee${levelled === 1 ? '' : 's'} on a level that no longer exists ${levelled === 1 ? 'is' : 'are'} on Standard now (there are three levels: Standard, Auto, Unrestricted)`);
    this.sessions.adoptUnrestrictedDefault();
    const toReview = this.tasks.adoptReviewDefault();
    if (toReview) this.core.log('info', `${toReview} open task${toReview === 1 ? '' : 's'} will be reviewed when finished (every task is, from now on, unless chosen otherwise)`);
    const rerouted = this.tasks.rerouteReviews();
    if (rerouted) this.core.log('info', `${rerouted} finished task${rerouted === 1 ? '' : 's'} that waited for a review nobody was asked for ${rerouted === 1 ? 'was' : 'were'} given to a colleague to review`);
    this.waits.restore();
    this.comms.restore();
    try {
      this.saidFiles.sweep();
      const swept = this.attachments.sweep();
      if (swept) this.core.log('info', `removed ${swept} unfinished upload${swept === 1 ? '' : 's'} left from before the restart`);
    } catch (e) {
      this.core.log('warn', `sweeping unfinished uploads: ${(e as Error).message}`);
    }
    this.meetings.restore();
    for (const h of this.core.hosts.filter((x) => x.status === 'online')) {
      h.status = 'offline';
      this.core.hosts.put(h);
    }
    // Tasks whose prompt never left the queue are re-queued once their employee is reachable again.
    for (const p of this.core.projects.all()) {
      if (!p.workspace) {
        p.workspace = 'worktrees';
        p.ownerEmployeeId = p.ownerEmployeeId ?? null;
        this.core.projects.put(p);
      }
    }
    for (const t of this.core.tasks.all()) {
      // Records written before a field existed get its neutral value.
      if (!t.friction) {
        t.friction = { failedVerifications: 0, reviewRejections: 0, mergeConflicts: 0, blockers: 0, questions: 0, denials: 0 };
        this.core.tasks.put(t);
      }
    }
    for (const t of this.core.tasks.filter((x) => x.status === 'IN_PROGRESS' && x.delivery.status === 'queued')) {
      t.status = 'READY';
      t.delivery = { status: 'none', via: null, ts: null, detail: null };
      this.core.tasks.put(t);
    }
    this.housekeeping = setInterval(() => {
      this.core.store.pruneProcessed();
      this.comms.prune();
    }, 3600_000);
    this.housekeeping.unref?.();
    // An account's figures arrive only while a session on it reports; a look every minute catches the rest.
    this.accountsTimer = setInterval(() => void this.sessions.failover(), this.core.timings.accountFailoverMs ?? 60_000);
    this.accountsTimer.unref?.();
    this.employees.unseatForemen();
    this.foreman.start();
    this.routines.start();
    this.sleeper.start();
    this.work.start();
    this.tasks.schedule();
  }

  stop(): void {
    if (this.housekeeping) clearInterval(this.housekeeping);
    if (this.accountsTimer) clearInterval(this.accountsTimer);
    this.foreman.stop();
    this.routines.stop();
    this.sleeper.stop();
    this.work.stop();
  }

  // ─────────────────────────── snapshots ───────────────────────────

  state(): FullState {
    const c = this.core;
    return {
      serverTime: nowIso(),
      settings: c.settings,
      layout: c.layout,
      hosts: c.hosts.all(),
      employees: c.employees.all(),
      sessions: c.sessions.all(),
      projects: c.projects.all(),
      tasks: c.tasks.all(),
      questions: c.questions.filter((q) => q.status === 'open' || q.status === 'answered' || Date.now() - Date.parse(q.createdAt) < 7 * 86400_000),
      messages: c.messages
        .all()
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .slice(-300),
      collabs: c.collabs.all().slice(-200),
      notifications: c.notifications.all(),
      meetings: c.meetings.all(),
      artifacts: c.artifacts.all().map((a) => ({ ...a, content: a.content.length > 20000 ? a.content.slice(0, 20000) + '\n… (truncated)' : a.content })),
      milestones: c.milestones,
      company: c.company,
      lessons: c.lessons.all(),
      improvements: c.improvements.all(),
      performance: this.improver.performance(),
      routines: this.routines.list(),
      events: c.store.queryEvents({ limit: 400, excludeTypes: ['terminal.output'] }),
    };
  }

  // ───────────────────────────── hiring ────────────────────────────

  /**
   * Hire an employee. When they are given a folder and no project, the folder
   * becomes their own project, worked in place — "each employee manages the
   * project in the folder they live in". Orchestrator still manages them all.
   */
  async hire(input: EmployeeInput & { ownFolderProject?: boolean; verifyCommand?: string | null }, actor = 'owner', by: { hiredBy?: string | null } = {}): Promise<Employee> {
    const folder = input.workingDir?.trim();
    // (The foreman's folder is only where its session runs: it is not a project, and a refused hire must leave nothing behind.)
    // (Nor is a lead's: it hands work on from there.)
    const foreman = !!input.roleKey && directsOthers((roleByKey(input.roleKey) ?? matchRole(input.roleKey))?.key);
    if (!folder || input.projectId || input.ownFolderProject === false || foreman) return this.employees.create(input, actor, by);
    const hostId = input.hostId ?? this.core.hosts.find((h) => h.local && h.status !== 'revoked')?.id ?? this.core.hosts.find((h) => h.status === 'online')?.id ?? null;
    if (!hostId || !this.core.agents.isOnline(hostId)) return this.employees.create({ ...input, hostId }, actor, by);
    const { project, root } = await this.projectOfFolder(hostId, folder, input.name.trim(), actor, input.verifyCommand ?? null);
    const employee = this.employees.create({ ...input, hostId, projectId: project.id, workingDir: root }, actor, by);
    if (project.workspace === 'in_place' && !project.ownerEmployeeId) {
      project.ownerEmployeeId = employee.id;
      this.core.put('project', project);
    }
    return employee;
  }

  /**
   * The project of a folder on a machine: the one that already lives there, or a new one worked in place, named
   * after the folder. The folder has to exist there (the machine is asked) — it is what a session is started in.
   */
  private async projectOfFolder(hostId: string, folder: string, whose: string, actor: string, verifyCommand: string | null = null): Promise<{ project: Project; root: string }> {
    const insp = await this.core.agents.rpc(hostId, { method: 'fs.inspect', params: { path: folder } }).catch((e) => {
      throw new EngineError(`the host rejected that folder: ${(e as Error).message}`);
    });
    if (!insp.exists) throw new EngineError(`${folder} does not exist on that machine yet. Make it first: "Browse…" → "New folder" where the folder is chosen.`);
    if (!insp.isDirectory) throw new EngineError(`${folder} is not a directory on that machine`);
    const root: string = insp.repoRoot ?? insp.path;
    let project = this.core.projects.find((p) => p.hostId === hostId && p.repoPath === root && p.status !== 'archived');
    if (!project) {
      const baseName = root.split('/').filter(Boolean).pop() ?? 'project';
      let name = baseName;
      for (let i = 2; this.core.projects.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.status !== 'archived'); i++) name = `${baseName} (${i})`;
      project = await this.tasks.createProject({ name, repoPath: root, hostId, workspace: 'in_place', verifyCommand, description: `${whose}'s folder: ${root}` }, actor);
    }
    return { project, root };
  }

  /**
   * Change an employee — and, when the change names a folder (`folder`), give them that folder to live in the way
   * hiring does: the folder becomes their own project, worked in place (or they join the project that already
   * lives there). A foreman's or a lead's folder is only where their session runs. The folder is on the machine
   * they are on, or on the one the same change puts them on. It takes effect when their session next starts.
   */
  async updateEmployee(id: string, patch: Record<string, unknown>, actor = 'owner'): Promise<Employee> {
    const { folder: named, ...rest } = patch;
    if (typeof named !== 'string' || !named.trim()) return this.employees.update(id, rest as any, actor);
    const e = this.core.employees.require(id);
    const folder = named.trim();
    const role = typeof rest.roleKey === 'string' ? rest.roleKey : e.roleKey;
    if (directsOthers((roleByKey(role) ?? matchRole(role))?.key)) return this.employees.update(id, { ...rest, workingDir: folder } as any, actor);
    const hostId = (typeof rest.hostId === 'string' && rest.hostId ? rest.hostId : e.hostId) ?? null;
    const host = hostId ? this.core.hosts.get(hostId) : undefined;
    if (!host) throw new EngineError('choose the machine first: a folder is on a machine');
    if (!this.core.agents.isOnline(host.id)) throw new EngineError(`${host.name} is offline, so that folder cannot be looked at now`);
    const { project, root } = await this.projectOfFolder(host.id, folder, e.name, actor);
    const updated = this.employees.update(id, { ...rest, projectId: project.id, workingDir: root } as any, actor);
    if (project.workspace === 'in_place' && !project.ownerEmployeeId) {
      project.ownerEmployeeId = updated.id;
      this.core.put('project', project);
    }
    return updated;
  }

  // ─────────────────────── cross-module helpers ────────────────────

  addArtifact(a: { kind: Artifact['kind']; title: string; content: string; projectId?: string | null; taskId?: string | null; meetingId?: string | null; employeeId?: string | null }): Artifact {
    const art: Artifact = { id: newId().slice(0, 8), kind: a.kind, title: a.title, content: a.content, projectId: a.projectId ?? null, taskId: a.taskId ?? null, meetingId: a.meetingId ?? null, employeeId: a.employeeId ?? null, createdAt: nowIso() };
    return this.core.put('artifact', art);
  }

  /** Where an employee keeps their work: the folder of their running session, else their own folder or project. */
  private folderOf(employeeId: string): { hostId: string; cwd: string } | null {
    const employee = this.core.employees.require(employeeId);
    // Their running session's folder; failing that, where they last worked (on a shared project that is
    // their own worktree, not the repository itself); failing that, the folder or project they were given.
    const session =
      this.core.runningSessionOf(employeeId) ??
      this.core.sessions
        .filter((x) => x.employeeId === employeeId && x.origin === 'managed')
        .sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))[0];
    const project = this.core.projects.get(employee.projectId);
    const cwd = session?.cwd ?? employee.workingDir ?? project?.repoPath ?? null;
    const hostId = session?.hostId ?? employee.hostId;
    return cwd && hostId ? { hostId, cwd } : null;
  }

  /** The Markdown documents next to an employee's work (read from the machine, never cached here). */
  async documents(employeeId: string): Promise<{ root: string | null; files: Array<{ path: string; size: number; modifiedAt: string }>; truncated: boolean; unavailable?: string }> {
    const where = this.folderOf(employeeId);
    if (!where) return { root: null, files: [], truncated: false, unavailable: 'This employee has no folder yet.' };
    if (!this.core.agents.isOnline(where.hostId)) return { root: where.cwd, files: [], truncated: false, unavailable: 'Their machine is offline, so its files cannot be read right now.' };
    return this.core.agents.rpc(where.hostId, { method: 'fs.docs.list', params: { cwd: where.cwd } });
  }

  async document(employeeId: string, relativePath: string): Promise<{ path: string; content: string; truncated: boolean; modifiedAt: string }> {
    const where = this.folderOf(employeeId);
    if (!where) throw new EngineError('this employee has no folder');
    if (!relativePath) throw new EngineError('which file?');
    return this.core.agents.rpc(where.hostId, { method: 'fs.docs.read', params: { cwd: where.cwd, path: relativePath } });
  }

  /** Pause a project: stop scheduling it and interrupt whoever is working on it. */
  async pauseProject(projectId: string, actor = 'owner'): Promise<number> {
    const project = this.core.projects.require(projectId);
    this.tasks.updateProject(projectId, { status: 'paused' }, actor);
    let interrupted = 0;
    for (const t of this.core.tasks.filter((x) => x.projectId === project.id && x.status === 'IN_PROGRESS')) {
      const session = this.core.runningSessionOf(t.assigneeId);
      if (session && this.core.agents.isOnline(session.hostId)) {
        // A real interrupt in the real terminal — not just a board change.
        await this.core.agents.rpc(session.hostId, { method: 'session.interrupt', params: { sessionId: session.id } }).catch(() => undefined);
        if (session.capabilities.hooks) session.inTurn = false;
        this.sessions.setActivity(session, 'idle', 'Interrupted: project paused');
        this.core.event({ type: 'terminal.interrupt', source: 'owner', summary: `${this.core.employees.get(t.assigneeId)?.name ?? 'Employee'} was interrupted: project ${project.name} paused`, sessionId: session.id, employeeId: t.assigneeId, taskId: t.id, projectId, data: {} });
      }
      this.comms.cancelFor({ kind: 'task', id: t.id });
      t.status = 'READY';
      t.delivery = { status: 'none', via: null, ts: null, detail: null };
      t.history.push({ ts: nowIso(), status: 'READY', note: 'Project paused; work interrupted. Resumes on the same branch.', by: actor });
      this.core.put('task', t);
      interrupted++;
    }
    return interrupted;
  }

  /**
   * Delete a project from the office. Its tasks go with it (work in progress is interrupted first, in the real
   * terminals); its people stay, with no project; what was learned for this project alone is retired, and
   * suggestions about it are dismissed. Nothing on disk is touched: the folder, its branches and its worktrees
   * are the owner's, and stay exactly as they are.
   */
  /**
   * Delete an employee for good, with what is theirs: their session (stopped first), the record of their sessions,
   * the messages to and from them, their questions, requests to colleagues, notifications, routines, own lessons and
   * XP. Their tasks go with them (`tasks: 'delete'`) or go back on the board for someone else (`'keep'`: unfinished
   * ones become ready and unassigned, finished ones stay as a record). Archiving is the way to take somebody off the
   * floor and keep all of this.
   *
   * Left as they are: the event log and the audit log (what happened, happened), meetings they sat in, what the long
   * memory filed, and every folder, branch and conversation on the machine.
   */
  async deleteEmployee(employeeId: string, opts: { tasks?: 'delete' | 'keep' } = {}, actor = 'owner'): Promise<{ name: string; tasks: number; released: number; sessions: number; messages: number }> {
    const e = this.core.employees.require(employeeId);
    const withTasks = opts.tasks === 'delete';
    const theirs = this.core.tasks.filter((t) => t.assigneeId === e.id);
    const verifying = theirs.find((t) => this.tasks.isVerifying(t.id));
    if (verifying) throw new EngineError(`${verifying.key} is being verified right now. Delete ${e.name} when that has finished.`, 409);
    if (this.tasks.isStarting(e.id)) throw new EngineError(`A task is being handed to ${e.name} right now. Delete them in a moment, when that has finished.`, 409);
    if (this.core.sessions.find((s) => s.employeeId === e.id && s.status === 'host_offline')) throw new EngineError(`${e.name}'s session is still running on a machine that is away. Delete them when it is back, so the session can be stopped.`, 409);
    if (this.core.runningSessionOf(e.id)) await this.sessions.stop(e.id, { actor, reason: 'the employee was deleted' });

    const gone = new Set<string>();
    let released = 0;
    for (const t of theirs) {
      this.comms.cancelFor({ kind: 'task', id: t.id });
      if (withTasks) {
        gone.add(t.id);
        this.core.remove('task', t.id);
        continue;
      }
      const open = t.status === 'IN_PROGRESS' || t.status === 'BLOCKED' || t.status === 'REVIEW' || t.status === 'READY' || t.status === 'BACKLOG';
      t.assigneeId = null;
      if (t.status === 'IN_PROGRESS' || t.status === 'BLOCKED' || t.status === 'REVIEW') {
        t.status = 'READY';
        t.blockedReason = null;
      }
      t.history.push({ ts: nowIso(), status: t.status, note: open ? `${e.name} was deleted; back on the board for someone else` : `${e.name}, who did this, was deleted`, by: actor });
      t.updatedAt = nowIso();
      if (open) released++;
      this.core.put('task', t);
    }
    // Reviews of their work that colleagues were asked for are about tasks that no longer exist.
    for (const t of this.core.tasks.filter((x) => !!x.reviewOf && gone.has(x.reviewOf))) {
      this.comms.cancelFor({ kind: 'task', id: t.id });
      gone.add(t.id);
      this.core.remove('task', t.id);
    }
    for (const t of this.core.tasks.filter((x) => x.dependsOn.some((d) => gone.has(d)) || x.reviewerId === e.id)) {
      t.dependsOn = t.dependsOn.filter((d) => !gone.has(d));
      if (t.reviewerId === e.id) t.reviewerId = null;
      this.core.put('task', t);
    }
    for (const q of this.core.questions.filter((x) => x.employeeId === e.id || (!!x.taskId && gone.has(x.taskId)))) {
      if (q.status === 'open') this.comms.supersede(q.id, `${e.name} was deleted.`);
      if (q.employeeId === e.id) this.core.remove('question', q.id);
    }
    const messages = this.core.messages.filter((m) => m.toEmployeeId === e.id || m.from.id === e.id);
    for (const m of messages) {
      if (m.delivery.status === 'queued') this.comms.cancelFor({ kind: 'message', id: m.id });
      this.core.remove('message', m.id);
    }
    for (const c of this.core.collabs.filter((x) => x.fromEmployeeId === e.id || x.toEmployeeId === e.id)) this.core.remove('collab', c.id);
    for (const n of this.core.notifications.filter((x) => x.employeeId === e.id || (!!x.taskId && gone.has(x.taskId)))) this.core.remove('notification', n.id);
    for (const r of this.core.routines.filter((x) => x.employeeId === e.id)) this.core.remove('routine', r.id);
    for (const x of this.core.xp.filter((y) => y.employeeId === e.id)) this.core.xp.delete(x.id);
    for (const l of this.core.lessons.filter((x) => x.scope === 'employee' && x.employeeId === e.id)) this.core.remove('lesson', l.id);
    for (const imp of this.core.improvements.filter((x) => x.employeeId === e.id && x.status === 'proposed')) {
      imp.status = 'dismissed';
      imp.decidedAt = nowIso();
      this.core.put('improvement', imp);
    }
    for (const a of this.core.artifacts.filter((x) => x.employeeId === e.id)) {
      a.employeeId = null;
      this.core.put('artifact', a);
    }
    const sessions = this.core.sessions.filter((s) => s.employeeId === e.id);
    for (const s of sessions) {
      this.core.store.revokeCredentialsFor('mcp', s.id);
      this.core.remove('session', s.id);
    }
    this.core.remove('employee', e.id);
    this.core.audit(actor, 'employee.deleted', e.id, { name: e.name, role: e.roleKey, tasks: withTasks ? gone.size : 0, released, sessions: sessions.length, messages: messages.length });
    this.core.event({ type: 'employee.deleted', source: 'owner', summary: `${e.name} was deleted${withTasks && gone.size ? ` with ${gone.size} task${gone.size === 1 ? '' : 's'}` : released ? `; ${released} task${released === 1 ? ' is' : 's are'} back on the board` : ''}`, data: { name: e.name, tasks: withTasks ? gone.size : 0, released, sessions: sessions.length } });
    this.tasks.schedule();
    return { name: e.name, tasks: withTasks ? gone.size : 0, released, sessions: sessions.length, messages: messages.length };
  }

  async deleteProject(projectId: string, actor = 'owner'): Promise<{ name: string; tasks: number; interrupted: number; employees: string[] }> {
    const project = this.core.projects.require(projectId);
    const mine = (t: { projectId: string | null }) => t.projectId === project.id;
    const verifying = this.core.tasks.filter(mine).find((t) => this.tasks.isVerifying(t.id));
    if (verifying) throw new EngineError(`${verifying.key} is being verified right now. Delete the project when that has finished.`, 409);
    const interrupted = await this.pauseProject(projectId, actor);

    const tasks = this.core.tasks.filter(mine);
    const gone = new Set(tasks.map((t) => t.id));
    // Questions nobody needs answered any more: the work they were about does not exist.
    for (const q of this.core.questions.filter((x) => x.status === 'open' && (x.projectId === project.id || (!!x.taskId && gone.has(x.taskId))))) this.comms.supersede(q.id, `The project ${project.name} was deleted.`);
    for (const t of tasks) {
      this.comms.cancelFor({ kind: 'task', id: t.id });
      this.core.remove('task', t.id);
    }
    // Tasks of other projects that waited for one of these no longer wait for it.
    for (const t of this.core.tasks.filter((x) => x.dependsOn.some((d) => gone.has(d)))) {
      t.dependsOn = t.dependsOn.filter((d) => !gone.has(d));
      this.core.put('task', t);
    }
    const employees: string[] = [];
    for (const e of this.core.employees.filter((x) => x.projectId === project.id || !!x.alsoProjectIds?.includes(project.id))) {
      if (e.projectId === project.id) {
        e.projectId = null;
        if (!e.archived) employees.push(e.name);
      }
      if (e.alsoProjectIds) e.alsoProjectIds = e.alsoProjectIds.filter((id) => id !== project.id);
      this.core.put('employee', e);
    }
    for (const p of this.core.projects.filter((x) => !!x.dependsOn?.includes(project.id))) {
      p.dependsOn = p.dependsOn!.filter((id) => id !== project.id);
      this.core.put('project', p);
    }
    for (const l of this.core.lessons.filter((x) => x.scope === 'project' && x.projectId === project.id && x.status !== 'retired')) {
      l.status = 'retired';
      l.updatedAt = nowIso();
      this.core.put('lesson', l);
    }
    for (const imp of this.core.improvements.filter((x) => x.status === 'proposed' && x.projectId === project.id)) {
      imp.status = 'dismissed';
      imp.decidedAt = nowIso();
      this.core.put('improvement', imp);
    }
    // Meetings and reports stay as a record; they simply no longer point at a project.
    for (const m of this.core.meetings.filter((x) => x.projectId === project.id)) {
      m.projectId = null;
      this.core.put('meeting', m);
    }
    for (const a of this.core.artifacts.filter((x) => x.projectId === project.id)) {
      a.projectId = null;
      this.core.put('artifact', a);
    }
    this.core.remove('project', project.id);
    this.core.audit(actor, 'project.deleted', project.id, { name: project.name, repoPath: project.repoPath, tasks: tasks.length, interrupted, employees });
    this.core.event({ type: 'project.deleted', source: 'owner', summary: `Project "${project.name}" was deleted${tasks.length ? ` with its ${tasks.length} task${tasks.length === 1 ? '' : 's'}` : ''}`, data: { name: project.name, tasks: tasks.length, interrupted, employees } });
    this.tasks.schedule();
    return { name: project.name, tasks: tasks.length, interrupted, employees };
  }

  /** Answers to questions Orchestrator itself raised (merge conflicts, priority calls). */
  async onSystemAnswer(q: Question): Promise<void> {
    const answer = (q.answer ?? '').toLowerCase();
    if (q.kind === 'merge_conflict' && q.taskId) {
      const task = this.core.tasks.get(q.taskId);
      if (!task || task.status !== 'BLOCKED') return;
      // ("resolve it", alone at the end or followed by "have"/"author"; or "have …" — said without `resolve it\b.*(have|author)`, which reads to the end from every "resolve it".)
      const afterResolve = answer.indexOf('resolve it');
      if ((answer.endsWith('resolve it') || (afterResolve >= 0 && /^\b/.test(answer.slice(afterResolve + 10) || ' ') && /have|author/.test(answer.slice(afterResolve + 10))) || answer.startsWith('have ')) && !answer.includes('myself')) {
        // Back to the author: the conflict details travel with the task prompt.
        task.status = 'READY';
        task.released = true;
        task.blockedReason = null;
        task.priority = task.priority === 'urgent' ? 'urgent' : 'high';
        task.history.push({ ts: nowIso(), status: 'READY', note: 'Returned to the author to resolve the merge conflict', by: 'owner' });
        this.core.put('task', task);
        this.tasks.schedule();
      }
      return;
    }
    if (q.kind === 'priority') {
      const collab = this.core.collabs.find((c) => c.status === 'needs_decision' && c.toEmployeeId === q.employeeId && q.text.includes(c.summary));
      if (!collab) return;
      const requester = this.core.employees.get(collab.fromEmployeeId);
      const responder = this.core.employees.get(collab.toEmployeeId);
      const decline = /^decline/.test(answer);
      if (!decline && collab.projectId && responder) {
        this.tasks.createTask(
          { projectId: collab.projectId, title: collab.summary.slice(0, 90), description: `Requested by ${requester?.name ?? 'a teammate'}.\n\n${collab.detail}\n\nPrioritised by the boss: ${q.answer}`, assigneeId: responder.id, priority: /next|now|high|urgent/.test(answer) ? 'high' : 'normal', kind: 'feature', released: true },
          'owner',
        );
      }
      collab.status = decline ? 'declined' : 'new_task';
      this.core.put('collab', collab);
      if (requester) {
        this.comms.sendMessage({ from: { kind: 'owner', id: null, name: 'the boss' }, toEmployeeId: requester.id, body: decline ? `Your request "${collab.summary}" will not be done: ${q.answer}` : `Your request "${collab.summary}" is now a task for ${responder?.name ?? 'a teammate'} (${q.answer}).`, kind: 'answer' });
      }
    }
  }

  // ───────────────────────────── layout ────────────────────────────

  /** Places on the engineering floor where another four-desk pod fits. */
  private static readonly POD_SLOTS: Array<[number, number, string]> = [
    [-16.5, 6.2, 'south'],
    [-2.5, 12, 'south'],
    [4.5, 12, 'south'],
    // Where the office's first tables stand (`defaultLayout`): free again once such a table was taken away.
    [-16.5, -0.2, 'north'],
    [-9.5, -0.2, 'north'],
    [-2.5, -0.2, 'north'],
    [4.5, -0.2, 'north'],
    [-9.5, 6.2, 'south'],
    [-2.5, 6.2, 'south'],
    [4.5, 6.2, 'south'],
    [-9.5, 12, 'south'],
  ];

  /** How many more pods the floor can take. */
  freePodSlots(): number {
    return Engine.POD_SLOTS.filter(([x, z]) => !this.core.layout.desks.some((d) => Math.hypot(d.x - x, d.z - z) < 2.2)).length;
  }

  /** Expand the office: add a pod of four desks in the next free spot. */
  addDeskPod(actor = 'owner'): OfficeLayout {
    const slot = Engine.POD_SLOTS.find(([x, z]) => !this.core.layout.desks.some((d) => Math.hypot(d.x - x, d.z - z) < 2.2));
    if (!slot) throw new EngineError('the engineering floor is full; there is no room for another pod');
    const [cx, cz, zone] = slot;
    const n = this.core.store.nextCounter('pod');
    const desks = [
      { id: `x${n}-a`, x: cx - 0.95, z: cz - 0.5, rot: 0, zone, kind: 'standard' as const },
      { id: `x${n}-b`, x: cx + 0.95, z: cz - 0.5, rot: 0, zone, kind: 'standard' as const },
      { id: `x${n}-c`, x: cx - 0.95, z: cz + 0.5, rot: Math.PI, zone, kind: 'standard' as const },
      { id: `x${n}-d`, x: cx + 0.95, z: cz + 0.5, rot: Math.PI, zone, kind: 'standard' as const },
    ];
    return this.updateLayout({ ...this.core.layout, desks: [...this.core.layout.desks, ...desks] }, actor);
  }

  /** The pod a desk belongs to: desks are named `<pod>-a`, `<pod>-b`, … */
  static podOf(deskId: string): string {
    return deskId.replace(/-[a-z]$/, '');
  }

  /**
   * One more seat at a table. A pod starts as two desks facing two desks; further seats extend
   * it by one column (up to six seats), if that place is free of other desks.
   */
  addSeat(pod: string, actor = 'owner'): OfficeLayout {
    const desks = this.core.layout.desks.filter((d) => Engine.podOf(d.id) === pod);
    if (!desks.length) throw new EngineError('unknown table');
    if (desks.length >= 6) throw new EngineError('a table has at most six seats');
    // The pod's frame of reference, from the desks it has: columns 1.9 m apart, two rows 1 m apart.
    const xs = [...new Set(desks.map((d) => Math.round(d.x * 100) / 100))].sort((a, b) => a - b);
    const front = Math.min(...desks.map((d) => d.z));
    const back = Math.max(...desks.map((d) => d.z));
    const rowZ = back - front > 0.5 ? [front, back] : [front, front + 1];
    // A place is taken when a desk would stand in another: desks are 1.7 m wide and 0.85 m deep, in columns 1.9 m and
    // rows 1 m apart — so the seat across the table (1 m away) is a place of its own. A desk of ANOTHER table needs
    // room to walk between the two (0.9 m), or the tables would grow into each other.
    const taken = (x: number, z: number) =>
      this.core.layout.desks.some((d) => {
        const own = Engine.podOf(d.id) === pod;
        return Math.abs(d.x - x) < (own ? 1.8 : 2.6) && Math.abs(d.z - z) < (own ? 0.9 : 1.9);
      });
    // First a gap inside the pod's own columns, then a new column on the right, then on the left.
    const columns = [...xs, xs[xs.length - 1]! + 1.9, xs[0]! - 1.9];
    let spot: { x: number; z: number; rot: number } | null = null;
    for (const x of columns) {
      for (const [i, z] of rowZ.entries()) {
        if (!spot && !taken(x, z)) spot = { x, z, rot: i === 0 ? 0 : Math.PI };
      }
    }
    if (!spot) throw new EngineError('there is no room next to that table for another seat');
    const letters = 'abcdefgh'.split('').filter((l) => !desks.some((d) => d.id === `${pod}-${l}`));
    const desk = { id: `${pod}-${letters[0]}`, x: spot.x, z: spot.z, rot: spot.rot, zone: desks[0]!.zone, kind: 'standard' as const };
    return this.updateLayout({ ...this.core.layout, desks: [...this.core.layout.desks, desk] }, actor);
  }

  /**
   * Seats that an earlier version put in the wrong place: it took the seat across the table for taken, so a fifth
   * and a sixth seat went side by side in one row — into the table next door — instead of facing each other. Such a
   * seat is moved to where it belongs (the third column of its own table), with whoever sits at it.
   */
  repairSeats(): number {
    const layout = this.core.layout;
    const pods = new Map<string, OfficeLayout['desks']>();
    for (const d of layout.desks) pods.set(Engine.podOf(d.id), [...(pods.get(Engine.podOf(d.id)) ?? []), d]);
    let moved = 0;
    const desks = layout.desks.map((d) => ({ ...d }));
    for (const [pod, list] of pods) {
      if (list.length <= 4) continue;
      const base = list.filter((d) => /-[a-d]$/.test(d.id));
      if (base.length < 2) continue;
      const xs = [...new Set(base.map((d) => Math.round(d.x * 100) / 100))].sort((a, b) => a - b);
      const front = Math.min(...base.map((d) => d.z));
      const back = Math.max(...base.map((d) => d.z));
      if (xs.length !== 2 || back - front < 0.5) continue; // not the usual two by two: left as the owner arranged it
      const col = xs[1]! + 1.9;
      for (const extra of list.filter((d) => /-[e-h]$/.test(d.id))) {
        const inColumn = Math.abs(extra.x - col) < 0.05 || Math.abs(extra.x - (xs[0]! - 1.9)) < 0.05;
        const inRow = Math.abs(extra.z - front) < 0.05 || Math.abs(extra.z - back) < 0.05;
        if (inColumn && inRow) continue; // already where a seat of this table can be
        // The free place of the third column: front first, then back.
        for (const [z, rot] of [[front, 0], [back, Math.PI]] as const) {
          const free = !desks.some((d) => d.id !== extra.id && Math.abs(d.x - col) < 1.8 && Math.abs(d.z - z) < 0.9);
          if (!free) continue;
          const mine = desks.find((d) => d.id === extra.id)!;
          mine.x = col;
          mine.z = z;
          mine.rot = rot;
          moved++;
          break;
        }
      }
      void pod;
    }
    if (moved) this.updateLayout({ ...layout, desks }, 'office');
    return moved;
  }

  /** What is written on a table. An empty text removes the sign. */
  setPodLabel(pod: string, label: string, actor = 'owner'): OfficeLayout {
    if (!this.core.layout.desks.some((d) => Engine.podOf(d.id) === pod)) throw new EngineError('unknown table');
    const text = String(label ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 40);
    const labels = { ...(this.core.layout.podLabels ?? {}) };
    if (text) labels[pod] = text;
    else delete labels[pod];
    return this.updateLayout({ ...this.core.layout, podLabels: labels }, actor);
  }

  /**
   * Take desks away: one seat, or a whole table. Only empty ones — somebody sitting at any of them refuses the lot.
   * A table that is left with no desks loses its label with them. They come back with "add a table" (a free place on
   * the floor) or "+ seat" (while the table still has a desk).
   */
  removeDesks(deskIds: string[], actor = 'owner'): OfficeLayout {
    const ids = new Set(deskIds.map(String));
    if (!ids.size) throw new EngineError('name the desks to remove');
    for (const id of ids) if (!this.core.layout.desks.some((d) => d.id === id)) throw new EngineError('unknown desk');
    const occupant = this.core.employees.find((e) => !e.archived && !!e.deskId && ids.has(e.deskId));
    if (occupant) throw new EngineError(`${occupant.name} sits there; move them first`);
    const desks = this.core.layout.desks.filter((d) => !ids.has(d.id));
    const left = new Set(desks.map((d) => Engine.podOf(d.id)));
    const podLabels = Object.fromEntries(Object.entries(this.core.layout.podLabels ?? {}).filter(([pod]) => left.has(pod)));
    return this.updateLayout({ ...this.core.layout, desks, podLabels }, actor);
  }

  /** Remove an empty desk. */
  removeDesk(deskId: string, actor = 'owner'): OfficeLayout {
    if (!this.core.layout.desks.some((d) => d.id === deskId)) throw new EngineError('unknown desk');
    const occupant = this.core.employees.find((e) => !e.archived && e.deskId === deskId);
    if (occupant) throw new EngineError(`${occupant.name} sits there; move them first`);
    return this.updateLayout({ ...this.core.layout, desks: this.core.layout.desks.filter((d) => d.id !== deskId) }, actor);
  }

  updateLayout(layout: OfficeLayout, actor = 'owner'): OfficeLayout {
    if (!layout || !Array.isArray(layout.desks) || !Array.isArray(layout.rooms)) throw new EngineError('invalid layout');
    const ids = new Set<string>();
    for (const d of layout.desks) {
      if (!d.id || ids.has(d.id)) throw new EngineError(`duplicate or missing desk id "${d.id}"`);
      if (![d.x, d.z, d.rot].every(Number.isFinite)) throw new EngineError(`desk ${d.id} has invalid coordinates`);
      ids.add(d.id);
    }
    // Nobody may be left sitting at a desk that no longer exists.
    for (const e of this.core.employees.filter((x) => !!x.deskId && !ids.has(x.deskId!))) {
      e.deskId = null;
      this.core.put('employee', e);
    }
    this.core.setLayout({ ...layout, version: (this.core.layout.version ?? 1) + 1 });
    this.core.audit(actor, 'office.layout_updated', 'office', { desks: layout.desks.length });
    // (Not the foreman, who has no desk, and not someone on a member's own computer, who sits in that member's room.)
    for (const e of this.core.employees.filter((x) => !x.archived && !x.deskId && x.roleKey !== 'foreman' && !this.hosts.memberOfHost(x.hostId))) {
      const desk = this.employees.freeDesk();
      if (!desk) break;
      e.deskId = desk;
      this.core.put('employee', e);
    }
    return this.core.layout;
  }
}
