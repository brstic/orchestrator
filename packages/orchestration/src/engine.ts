import type { Artifact, Employee, FullState, OfficeLayout, Question } from '@orchestrator/contracts';
import { matchRole, newId, nowIso, roleByKey } from '@orchestrator/contracts';
import type { McpServerOptions } from '@orchestrator/integrations';
import { TerminalGateway, type GatewayDeps } from '@orchestrator/terminal';
import { CommandCenter } from './commands.ts';
import { Comms } from './comms.ts';
import { Core, EngineError, type EngineOptions } from './core.ts';
import { Foreman } from './foreman.ts';
import { HookReceiver } from './hook-receiver.ts';
import { Improver } from './improve.ts';
import { Vault } from './vault.ts';
import { MeetingManager } from './meetings.ts';
import { buildMcpServer, type McpContext } from './mcp-tools.ts';
import { EmployeeRegistry, HostRegistry, SessionRegistry, type EmployeeInput } from './registry.ts';
import { Routines } from './routines.ts';
import { Sleeper } from './sleep.ts';
import { TaskManager } from './tasks.ts';
import { Waits } from './waits.ts';

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
  readonly meetings: MeetingManager;
  readonly commands: CommandCenter;
  readonly improver: Improver;
  readonly foreman: Foreman;
  readonly routines: Routines;
  readonly sleeper: Sleeper;
  readonly waits: Waits;
  readonly vault: Vault;
  readonly mcp: McpServerOptions<McpContext>;
  private housekeeping: NodeJS.Timeout | null = null;

  constructor(opts: EngineOptions, gatewayDeps: Pick<GatewayDeps, 'send'>) {
    this.core = new Core(opts);
    this.hosts = new HostRegistry(this);
    this.employees = new EmployeeRegistry(this);
    this.sessions = new SessionRegistry(this);
    this.hooks = new HookReceiver(this);
    this.comms = new Comms(this);
    this.tasks = new TaskManager(this);
    this.meetings = new MeetingManager(this);
    this.commands = new CommandCenter(this);
    this.improver = new Improver(this);
    this.foreman = new Foreman(this);
    this.routines = new Routines(this);
    this.sleeper = new Sleeper(this);
    this.waits = new Waits(this);
    this.vault = new Vault(this.core, opts.vaultKeyFile ?? null);
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
    this.sessions.restore();
    this.waits.restore();
    this.comms.restore();
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
    this.employees.unseatForemen();
    this.foreman.start();
    this.routines.start();
    this.sleeper.start();
    this.tasks.schedule();
  }

  stop(): void {
    if (this.housekeeping) clearInterval(this.housekeeping);
    this.foreman.stop();
    this.routines.stop();
    this.sleeper.stop();
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
  async hire(input: EmployeeInput & { ownFolderProject?: boolean; verifyCommand?: string | null }, actor = 'owner'): Promise<Employee> {
    const folder = input.workingDir?.trim();
    // (The foreman's folder is only where its session runs: it is not a project, and a refused hire must leave nothing behind.)
    const foreman = !!input.roleKey && (roleByKey(input.roleKey) ?? matchRole(input.roleKey))?.key === 'foreman';
    if (!folder || input.projectId || input.ownFolderProject === false || foreman) return this.employees.create(input, actor);
    const hostId = input.hostId ?? this.core.hosts.find((h) => h.local && h.status !== 'revoked')?.id ?? this.core.hosts.find((h) => h.status === 'online')?.id ?? null;
    if (!hostId || !this.core.agents.isOnline(hostId)) return this.employees.create({ ...input, hostId }, actor);
    const insp = await this.core.agents.rpc(hostId, { method: 'fs.inspect', params: { path: folder } }).catch((e) => {
      throw new EngineError(`the host rejected that folder: ${(e as Error).message}`);
    });
    if (!insp.exists || !insp.isDirectory) throw new EngineError(`${folder} is not a directory on that machine`);
    const root: string = insp.repoRoot ?? insp.path;
    let project = this.core.projects.find((p) => p.hostId === hostId && p.repoPath === root && p.status !== 'archived');
    if (!project) {
      const baseName = root.split('/').filter(Boolean).pop() ?? 'project';
      let name = baseName;
      for (let i = 2; this.core.projects.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.status !== 'archived'); i++) name = `${baseName} (${i})`;
      project = await this.tasks.createProject({ name, repoPath: root, hostId, workspace: 'in_place', verifyCommand: input.verifyCommand ?? null, description: `${input.name.trim()}'s folder: ${root}` }, actor);
    }
    const employee = this.employees.create({ ...input, hostId, projectId: project.id, workingDir: root }, actor);
    if (project.workspace === 'in_place' && !project.ownerEmployeeId) {
      project.ownerEmployeeId = employee.id;
      this.core.put('project', project);
    }
    return employee;
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
      if (/resolve it$|resolve it\b.*(have|author)|^have /.test(answer) && !/myself/.test(answer)) {
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
    const taken = (x: number, z: number) => this.core.layout.desks.some((d) => Math.hypot(d.x - x, d.z - z) < 1.2);
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

  /** What is written on a table. An empty text removes the sign. */
  setPodLabel(pod: string, label: string, actor = 'owner'): OfficeLayout {
    if (!this.core.layout.desks.some((d) => Engine.podOf(d.id) === pod)) throw new EngineError('unknown table');
    const text = String(label ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 40);
    const labels = { ...(this.core.layout.podLabels ?? {}) };
    if (text) labels[pod] = text;
    else delete labels[pod];
    return this.updateLayout({ ...this.core.layout, podLabels: labels }, actor);
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
