import path from 'node:path';
import type { DeliveryState, Employee, Project, ProjectPolicy, Task, TaskKind, TaskPriority, TaskStatus, XpEntry } from '@orchestrator/contracts';
import { matchRole, newId, nowIso, redactSecrets, roleByKey, slugify, truncate } from '@orchestrator/contracts';
import { applyXp, evaluateMilestones, xpForCompletedTask, xpForReview } from '@orchestrator/game-systems';
import { EngineError } from './core.ts';
import type { Engine } from './engine.ts';
import { reviewPrompt, taskPrompt } from './prompts.ts';
import { routingPreference } from './learning/detect.ts';

const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const PROJECT_COLORS = ['#4f8cff', '#ff8c5a', '#5ad67d', '#c58cff', '#f5c542', '#ff5d73', '#3fd0c9', '#ff9ecb'];
/** Task kinds that produce documents or verdicts rather than commits. */
const NON_CODE_KINDS = new Set<TaskKind>(['review', 'research', 'planning']);
/** How long a task was actually being worked on: the time it spent IN_PROGRESS, from its own history. */
export function timeInProgress(task: Task): number {
  let total = 0;
  let since: number | null = null;
  for (const h of task.history) {
    const at = Date.parse(h.ts);
    if (h.status === 'IN_PROGRESS') since ??= at;
    else if (since !== null) {
      total += Math.max(0, at - since);
      since = null;
    }
  }
  return total;
}

const TASK_KINDS: TaskKind[] = ['feature', 'bug', 'test', 'review', 'research', 'planning', 'security', 'docs', 'ops', 'refactor', 'chore'];

export interface ProjectInput {
  name: string;
  description?: string;
  goals?: string;
  requirements?: string;
  docs?: string;
  hostId?: string | null;
  repoPath?: string | null;
  baseBranch?: string | null;
  verifyCommand?: string | null;
  verifyTimeoutSec?: number;
  color?: string;
  policy?: Partial<ProjectPolicy>;
  workspace?: Project['workspace'];
  ownerEmployeeId?: string | null;
  extraRepos?: Array<{ name?: string; path: string }>;
  dependsOn?: string[];
}

export interface TaskInput {
  projectId: string;
  title: string;
  description?: string;
  acceptance?: string;
  kind?: TaskKind;
  priority?: TaskPriority;
  assigneeId?: string | null;
  roleHint?: string | null;
  dependsOn?: string[];
  requiresReview?: boolean;
  reviewerId?: string | null;
  reviewOf?: string | null;
  verifyCommand?: string | null;
  released?: boolean;
  dedupeKey?: string | null;
}

/** A key as it is compared: trimmed, case-insensitive, bounded. */
export function dedupeKeyOf(raw: unknown): string | null {
  const k = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200) : '';
  return k || null;
}

export interface ProposedTask {
  title: string;
  description: string;
  acceptance?: string;
  kind?: string;
  role?: string;
  priority?: string;
  depends_on?: number[];
  /** What the task is about (a ticket id, a URL): a task of this project with the same key is not added again. */
  dedupe_key?: string;
}

function emptyEvidence(): Task['evidence'] {
  return { summary: null, reportedTests: null, commits: [], filesChanged: [], diffStat: null, verification: null, review: null, merge: null };
}

/**
 * Projects, the task board and the scheduler.
 *
 * A task only reaches DONE after Orchestrator has checked the work itself: a
 * clean tree, real commits on the task branch, the project's verification
 * command passing on the host, an approved review when required, and a merge
 * that did not conflict.
 */
export class TaskManager {
  private eng: Engine;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private startingEmployees = new Set<string>();
  private verifying = new Set<string>();
  private mergeChains = new Map<string, Promise<unknown>>();
  private celebrateTimers = new Map<string, NodeJS.Timeout>();

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  // ─────────────────────────── projects ────────────────────────────

  async createProject(input: ProjectInput, actor = 'owner'): Promise<Project> {
    const name = input.name?.trim();
    if (!name) throw new EngineError('a project needs a name');
    if (this.core.projects.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.status !== 'archived')) throw new EngineError(`a project named "${name}" already exists`);
    let hostId = input.hostId ?? null;
    let repoPath = input.repoPath?.trim() || null;
    let baseBranch = input.baseBranch?.trim() || 'main';
    if (repoPath) {
      hostId = hostId ?? this.core.hosts.find((h) => h.status === 'online')?.id ?? null;
      if (!hostId) throw new EngineError('no host is online to validate the repository path');
      if (!this.core.agents.isOnline(hostId)) throw new EngineError('the selected host is offline, so the repository path cannot be validated');
      const insp = await this.core.agents.rpc(hostId, { method: 'fs.inspect', params: { path: repoPath } }).catch((e) => {
        throw new EngineError(`the host rejected that path: ${(e as Error).message}`);
      });
      if (!insp.exists || !insp.isDirectory) throw new EngineError(`${repoPath} is not a directory on that host`);
      if (insp.isGitRepo) {
        if (!insp.hasCommits) throw new EngineError(`${insp.repoRoot} has no commits yet. Make an initial commit so employees can branch from it.`);
        repoPath = insp.repoRoot;
        if (!input.baseBranch && insp.branch && insp.branch !== 'HEAD') baseBranch = insp.branch;
      } else repoPath = insp.path;
    }
    const project: Project = {
      id: newId(),
      name,
      description: input.description ?? '',
      goals: input.goals ?? '',
      requirements: input.requirements ?? '',
      docs: input.docs ?? '',
      hostId,
      repoPath,
      baseBranch,
      integrationBranch: 'orchestrator/integration',
      workspace: input.workspace ?? 'worktrees',
      ownerEmployeeId: input.ownerEmployeeId ?? null,
      verifyCommand: input.verifyCommand?.trim() || null,
      verifyTimeoutSec: input.verifyTimeoutSec ?? Math.round(this.core.timings.verifyTimeoutMs / 1000),
      color: input.color ?? PROJECT_COLORS[this.core.projects.size % PROJECT_COLORS.length]!,
      status: 'active',
      policy: { allow: [], deny: [], highRiskPatterns: [], autoAssign: true, requireReview: false, autoMerge: true, ...(input.policy ?? {}) },
      milestones: [],
      extraRepos: this.cleanRepos(input.extraRepos, repoPath),
      dependsOn: this.cleanDependencies('', input.dependsOn),
      deliveredAt: null,
      createdAt: nowIso(),
    };
    this.core.put('project', project);
    this.core.audit(actor, 'project.created', project.id, { name, repoPath });
    this.core.event({ type: 'project.created', source: 'owner', summary: `Project "${name}" was created`, projectId: project.id, data: { repoPath, host: hostId } });
    return project;
  }

  updateProject(id: string, patch: Partial<ProjectInput> & { status?: Project['status']; milestones?: Project['milestones'] }, actor = 'owner'): Project {
    const p = this.core.projects.require(id);
    for (const key of ['name', 'description', 'goals', 'requirements', 'docs', 'verifyCommand', 'verifyTimeoutSec', 'color', 'baseBranch', 'status', 'milestones', 'workspace', 'ownerEmployeeId'] as const) {
      if (patch[key] !== undefined) (p as any)[key] = patch[key];
    }
    if (patch.policy) p.policy = { ...p.policy, ...patch.policy };
    if (patch.extraRepos !== undefined) p.extraRepos = this.cleanRepos(patch.extraRepos, p.repoPath);
    if (patch.dependsOn !== undefined) p.dependsOn = this.cleanDependencies(id, patch.dependsOn);
    this.core.put('project', p);
    this.core.audit(actor, 'project.updated', id, { fields: Object.keys(patch) });
    this.core.event({ type: 'project.updated', source: 'owner', summary: `Project "${p.name}" was updated${patch.status ? ` (${patch.status})` : ''}`, projectId: id, data: { fields: Object.keys(patch) } });
    if (p.status === 'active') this.schedule();
    return p;
  }

  /** Additional repositories: absolute paths on the project's machine, each once, never the main repository itself. */
  private cleanRepos(input: unknown, main: string | null): NonNullable<Project['extraRepos']> {
    const out: NonNullable<Project['extraRepos']> = [];
    for (const r of Array.isArray(input) ? input : []) {
      const p = String(r?.path ?? '').trim().replace(/\/+$/, '');
      if (!p) continue;
      if (!path.isAbsolute(p) || p.includes('\0') || p.length > 400) throw new EngineError(`"${p}" is not an absolute folder path`);
      if (p === main || out.some((x) => x.path === p)) continue;
      out.push({ name: String(r?.name ?? '').trim().slice(0, 60) || path.basename(p), path: p });
    }
    if (out.length > 12) throw new EngineError('a project can have at most 12 additional repositories');
    return out;
  }

  /** Project dependencies: existing projects, not itself, and never a circle. */
  private cleanDependencies(id: string, input: unknown): string[] {
    const ids = [...new Set((Array.isArray(input) ? input : []).map(String))];
    for (const dep of ids) {
      const other = this.core.projects.get(dep);
      if (!other) throw new EngineError('unknown project in the dependencies');
      if (dep === id) throw new EngineError('a project cannot depend on itself');
      // Walk what the other one depends on: reaching this project again would be a circle.
      const seen = new Set<string>();
      const walk = (at: string): boolean => at === id || (!seen.has(at) && (seen.add(at), (this.core.projects.get(at)?.dependsOn ?? []).some(walk)));
      if ((other.dependsOn ?? []).some(walk)) throw new EngineError(`${other.name} already depends on this project: that would be a circle`);
    }
    return ids;
  }

  /** Move every employee of one project onto another (their running work is not interrupted). */
  moveTeam(fromProjectId: string, toProjectId: string, actor = 'owner'): Employee[] {
    this.core.projects.require(fromProjectId);
    const to = this.core.projects.require(toProjectId);
    const moved = this.core.employees.filter((e) => !e.archived && e.projectId === fromProjectId);
    for (const e of moved) {
      e.projectId = to.id;
      this.core.put('employee', e);
    }
    this.core.audit(actor, 'project.team_moved', toProjectId, { from: fromProjectId, employees: moved.map((e) => e.name) });
    this.schedule();
    return moved;
  }

  // ───────────────────────────── tasks ─────────────────────────────

  currentTask(employeeId: string | null | undefined): Task | undefined {
    if (!employeeId) return undefined;
    return this.core.tasks
      .filter((t) => t.assigneeId === employeeId && t.status === 'IN_PROGRESS')
      .sort((a, b) => ((b.startedAt ?? '') > (a.startedAt ?? '') ? 1 : -1))[0];
  }

  taskByKey(key: string, projectId?: string | null): Task | undefined {
    const k = key.trim().toUpperCase();
    return this.core.tasks.find((t) => t.key.toUpperCase() === k && (!projectId || t.projectId === projectId)) ?? this.core.tasks.find((t) => t.key.toUpperCase() === k) ?? this.core.tasks.get(key);
  }

  /** May this employee know about a task? Those of the shared office, or of the member's computer they are on themselves. */
  canSee(e: Employee, t: Task): boolean {
    const personal = (hostId: string | null | undefined) => !!this.core.hosts.get(hostId ?? '')?.memberId;
    const projectHost = this.core.projects.get(t.projectId)?.hostId ?? null;
    return !(personal(e.hostId) || personal(projectHost)) || e.hostId === projectHost;
  }

  /** Unfinished tasks this one waits for. */
  openDependencies(task: Task): Task[] {
    return task.dependsOn.map((id) => this.core.tasks.get(id)).filter((t): t is Task => !!t && t.status !== 'DONE');
  }

  private depsDone(task: Task): boolean {
    return task.dependsOn.every((id) => this.core.tasks.get(id)?.status === 'DONE');
  }

  private history(task: Task, note: string, by: string): void {
    task.history.push({ ts: nowIso(), status: task.status, note, by });
    if (task.history.length > 100) task.history.splice(0, task.history.length - 100);
    task.updatedAt = nowIso();
  }

  createTask(input: TaskInput, by = 'owner'): Task {
    const project = this.core.projects.require(input.projectId);
    const title = input.title?.trim();
    if (!title) throw new EngineError('a task needs a title');
    if (input.assigneeId) this.core.employees.require(input.assigneeId);
    for (const dep of input.dependsOn ?? []) if (!this.core.tasks.get(dep)) throw new EngineError(`unknown dependency ${dep}`);
    const kind = input.kind && TASK_KINDS.includes(input.kind) ? input.kind : 'feature';
    const now = nowIso();
    const task: Task = {
      id: newId(),
      key: `T-${this.core.store.nextCounter('task')}`,
      projectId: project.id,
      title,
      description: input.description ?? '',
      acceptance: input.acceptance ?? '',
      kind,
      priority: input.priority ?? 'normal',
      status: 'BACKLOG',
      assigneeId: input.assigneeId ?? null,
      roleHint: input.roleHint ?? null,
      dependsOn: input.dependsOn ?? [],
      branch: null,
      worktree: null,
      baseSha: null,
      requiresReview: input.requiresReview ?? (project.policy.requireReview && !NON_CODE_KINDS.has(kind)),
      reviewerId: input.reviewerId ?? null,
      reviewOf: input.reviewOf ?? null,
      verifyCommand: input.verifyCommand ?? null,
      released: input.released ?? true,
      nudges: 0,
      friction: { failedVerifications: 0, reviewRejections: 0, mergeConflicts: 0, blockers: 0, questions: 0, denials: 0 },
      blockedReason: null,
      progress: { percent: null, note: null, ts: null },
      evidence: emptyEvidence(),
      history: [],
      attempts: 0,
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      delivery: { status: 'none', via: null, ts: null, detail: null },
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    };
    if (task.released && this.depsDone(task)) task.status = 'READY';
    this.history(task, 'Created', by);
    this.core.put('task', task);
    this.core.event({
      type: 'task.created',
      source: by === 'owner' ? 'owner' : by.startsWith('employee:') ? 'mcp' : 'server',
      summary: `${task.key} created: ${title}`,
      taskId: task.id,
      projectId: project.id,
      employeeId: task.assigneeId,
      data: { key: task.key, kind, by, released: task.released },
    });
    if (task.assigneeId) this.emitAssigned(task, by);
    this.schedule();
    return task;
  }

  private emitAssigned(task: Task, by: string): void {
    const emp = this.core.employees.get(task.assigneeId);
    if (!emp) return;
    this.core.event({ type: 'task.assigned', source: by === 'owner' ? 'owner' : 'server', summary: `${task.key} assigned to ${emp.name}`, taskId: task.id, projectId: task.projectId, employeeId: emp.id, data: { key: task.key, by } });
  }

  updateTask(id: string, patch: Partial<TaskInput> & { status?: TaskStatus }, actor = 'owner'): Task {
    const task = this.core.tasks.require(id);
    if (patch.assigneeId !== undefined && patch.assigneeId !== task.assigneeId) {
      if (task.status === 'IN_PROGRESS') throw new EngineError(`${task.key} is in progress; block or finish it before reassigning`);
      if (patch.assigneeId) this.core.employees.require(patch.assigneeId);
      task.assigneeId = patch.assigneeId;
      this.history(task, patch.assigneeId ? `Assigned to ${this.core.employees.get(patch.assigneeId)?.name}` : 'Unassigned', actor);
      if (patch.assigneeId) this.emitAssigned(task, actor);
    }
    for (const key of ['title', 'description', 'acceptance', 'kind', 'priority', 'roleHint', 'dependsOn', 'requiresReview', 'reviewerId', 'verifyCommand', 'released'] as const) {
      if (patch[key] !== undefined) (task as any)[key] = patch[key];
    }
    if (patch.status && patch.status !== task.status) this.moveByOwner(task, patch.status, actor);
    task.updatedAt = nowIso();
    this.core.put('task', task);
    this.core.event({ type: 'task.updated', source: 'owner', summary: `${task.key} was updated`, taskId: id, projectId: task.projectId, employeeId: task.assigneeId, data: { fields: Object.keys(patch), quiet: true } });
    this.schedule();
    return task;
  }

  /** Manual board moves by the owner. DONE is never set by hand without saying so in the record. */
  private moveByOwner(task: Task, status: TaskStatus, actor: string): void {
    const from = task.status;
    if (status === 'IN_PROGRESS') throw new EngineError('tasks start when they are delivered to an employee; move the task to READY and assign it');
    if (from === 'IN_PROGRESS' && (status === 'READY' || status === 'BACKLOG')) {
      this.eng.comms.cancelFor({ kind: 'task', id: task.id });
      task.delivery = { status: 'none', via: null, ts: null, detail: null };
    }
    if (status === 'READY') {
      task.released = true;
      if (!this.depsDone(task)) throw new EngineError(`${task.key} still has unfinished dependencies`);
    }
    if (status === 'BACKLOG') task.released = false;
    if (status === 'BLOCKED') task.blockedReason = task.blockedReason ?? 'Blocked by the owner';
    else task.blockedReason = null;
    task.status = status;
    if (status === 'DONE') {
      task.completedAt = nowIso();
      this.history(task, `Marked done manually by ${actor} (not verified by Orchestrator)`, actor);
      this.core.event({ type: 'task.completed', source: 'owner', summary: `${task.key} was marked done manually (unverified)`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, manual: true, verified: false } });
    } else this.history(task, `Moved ${from} → ${status}`, actor);
  }

  release(taskIds: string[], actor = 'owner'): Task[] {
    const out: Task[] = [];
    for (const id of taskIds) {
      const t = this.core.tasks.get(id);
      if (!t || t.released) continue;
      t.released = true;
      this.history(t, 'Released for scheduling', actor);
      this.core.put('task', t);
      out.push(t);
    }
    this.schedule();
    return out;
  }

  /** Is this task's verification command running right now? */
  isVerifying(id: string): boolean {
    return this.verifying.has(id);
  }

  deleteTask(id: string, actor = 'owner'): void {
    const task = this.core.tasks.require(id);
    if (task.status === 'IN_PROGRESS') throw new EngineError('cannot delete a task that is in progress');
    for (const t of this.core.tasks.filter((x) => x.dependsOn.includes(id))) {
      t.dependsOn = t.dependsOn.filter((d) => d !== id);
      this.core.put('task', t);
    }
    this.core.remove('task', id);
    this.core.audit(actor, 'task.deleted', id, { key: task.key });
    this.schedule();
  }

  // ─────────────────────────── scheduler ───────────────────────────

  schedule(): void {
    if (this.scheduleTimer) return;
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      try {
        this.runSchedule();
      } catch (e) {
        this.core.log('error', `scheduler: ${(e as Error).stack}`);
      }
    }, this.core.timings.scheduleDebounceMs);
    this.scheduleTimer.unref?.();
  }

  withinSchedule(e: Employee): boolean {
    if (!e.schedule.available) return false;
    if (!e.schedule.from || !e.schedule.to) return true;
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return e.schedule.from <= e.schedule.to ? hm >= e.schedule.from && hm < e.schedule.to : hm >= e.schedule.from || hm < e.schedule.to;
  }

  /** A task is being handed to them this very moment (their session may be starting for it). */
  isStarting(employeeId: string): boolean {
    return this.startingEmployees.has(employeeId);
  }

  /** Is this employee genuinely able to take a new task right now? */
  isFree(e: Employee): boolean {
    if (e.archived || !this.withinSchedule(e)) return false;
    if (this.startingEmployees.has(e.id) || this.currentTask(e.id)) return false;
    if (!e.hostId || !this.core.agents.isOnline(e.hostId)) return false;
    if (this.eng.hosts.exhausted(e.hostId)) return false;
    const s = this.core.runningSessionOf(e.id);
    if (s && this.core.gateway.isPaused(s.id)) return false;
    if (this.eng.meetings.isBusy(e.id)) return false;
    return true;
  }

  private lastRoutingReason: string | null = null;

  private pickEmployee(task: Task): Employee | undefined {
    const wantedRole = task.roleHint ? (roleByKey(task.roleHint) ?? matchRole(task.roleHint)) : undefined;
    // Work stays on the computer its project is on: nothing shared goes to a member's own employee, and the other way round.
    const projectHost = this.core.projects.get(task.projectId)?.hostId ?? null;
    const sameComputer = (e: Employee) => !(this.eng.hosts.memberOfHost(e.hostId) || this.eng.hosts.memberOfHost(projectHost)) || e.hostId === projectHost;
    // A person's own session is given work only by a person, never by the scheduler.
    const pool = this.core.employees.filter((e) => !e.selfDriven && this.isFree(e) && sameComputer(e) && (e.projectId === task.projectId || e.projectId === null || !!e.alsoProjectIds?.includes(task.projectId)));
    let best: { e: Employee; score: number; reason: string | null } | undefined;
    for (const e of pool) {
      // A foreman supervises; work is never routed to one.
      if (e.roleKey === 'foreman') continue;
      const role = roleByKey(e.roleKey);
      let score = 0;
      if (wantedRole) {
        if (e.roleKey === wantedRole.key) score += 10;
        else if (e.roleKey === 'fullstack' && (wantedRole.key === 'backend' || wantedRole.key === 'frontend')) score += 4;
        else continue;
      } else if (role?.handles.includes(task.kind)) score += 5;
      else continue;
      if (e.projectId === task.projectId) score += 2;
      else if (e.alsoProjectIds?.includes(task.projectId)) score += 1;
      if (task.reviewOf && this.core.tasks.get(task.reviewOf)?.assigneeId === e.id) continue;
      // Measured track record on this kind of task breaks ties between suitable people.
      const learned = this.eng.improver.routingBonus(e, task.kind);
      score += learned.bonus;
      // A preference the owner accepted from the record ("give this kind to X first") decides between suitable people.
      const preferred = routingPreference(this.core.settings, this.core.projects.get(task.projectId), task.kind, e.id);
      score += preferred.bonus;
      if (!best || score > best.score) best = { e, score, reason: preferred.reason ?? learned.reason };
    }
    this.lastRoutingReason = best?.reason ?? null;
    return best?.e;
  }

  private runSchedule(): void {
    for (const project of this.core.projects.filter((p) => p.status === 'active')) {
      const tasks = this.core.tasks.filter((t) => t.projectId === project.id);
      for (const t of tasks) {
        if (t.status === 'BACKLOG' && t.released && this.depsDone(t)) {
          t.status = 'READY';
          this.history(t, 'Dependencies complete', 'scheduler');
          this.core.put('task', t);
          this.core.event({ type: 'task.updated', source: 'server', summary: `${t.key} is ready`, taskId: t.id, projectId: project.id, employeeId: t.assigneeId, data: { key: t.key, status: 'READY' } });
        }
      }
      const ready = tasks.filter((t) => t.status === 'READY').sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (a.createdAt < b.createdAt ? -1 : 1));
      for (const t of ready) {
        let assignee = this.core.employees.get(t.assigneeId);
        if (assignee && !this.isFree(assignee)) continue;
        if (!assignee) {
          if (!project.policy.autoAssign) continue;
          assignee = this.pickEmployee(t);
          if (!assignee) continue;
          t.assigneeId = assignee.id;
          this.history(t, `Auto-assigned to ${assignee.name}${this.lastRoutingReason ? ` (track record: ${this.lastRoutingReason})` : ''}`, 'scheduler');
          this.core.put('task', t);
          this.emitAssigned(t, 'scheduler');
        }
        this.startingEmployees.add(assignee.id);
        const emp = assignee;
        void this.startTask(t)
          .catch((e) => this.core.log('error', `starting ${t.key}: ${e?.stack ?? e}`))
          .finally(() => this.startingEmployees.delete(emp.id));
      }
    }
  }

  // ─────────────────────────── execution ───────────────────────────

  private repoFor(project: Project, employee: Employee): string | null {
    if (!project.repoPath) return null;
    if (!project.hostId || project.hostId === employee.hostId) return project.repoPath;
    // The project's repository lives on another machine: this employee needs their own clone.
    return employee.workingDir;
  }

  worktreePaths(repo: string, employee: Employee): { employee: string; integration: string } {
    const root = path.join(path.dirname(repo), '.orchestrator-worktrees', path.basename(repo));
    return { employee: path.join(root, slugify(employee.name)), integration: path.join(root, '_integration') };
  }

  private fail(task: Task, reason: string): void {
    task.status = 'BLOCKED';
    task.blockedReason = reason;
    this.history(task, `Blocked: ${reason}`, 'orchestrator');
    this.core.put('task', task);
    const emp = this.core.employees.get(task.assigneeId);
    this.core.event({ type: 'task.blocked', source: 'server', summary: `${task.key} is blocked: ${truncate(reason, 140)}`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, reason } });
    this.eng.comms.notify({ kind: 'blocked', severity: 'critical', title: `${task.key} is blocked`, body: reason, taskId: task.id, projectId: task.projectId, employeeId: emp?.id ?? null });
  }

  /** Prepare an isolated workspace, make sure the employee's real session is up, and hand over the task. */
  async startTask(task: Task): Promise<void> {
    const employee = this.core.employees.require(task.assigneeId!);
    const project = this.core.projects.require(task.projectId);
    try {
      // Someone lent to this project keeps their own; anyone else moves here with the task.
      if (employee.projectId !== project.id && !employee.alsoProjectIds?.includes(project.id)) {
        employee.projectId = project.id;
        this.core.put('employee', employee);
      }
      const hostId = employee.hostId!;
      const attached = this.core.runningSessionOf(employee.id);
      const isAttached = attached?.origin === 'attached';
      const codeTask = !NON_CODE_KINDS.has(task.kind);
      const repo = this.repoFor(project, employee);
      let cwd: string;
      let branch: string | null = task.branch;
      let baseSha: string | null = task.baseSha;
      if (repo && !isAttached && project.workspace === 'in_place') {
        // The employee lives in this folder: work happens right here, on the branch that is
        // checked out. Nothing is created, switched or merged by Orchestrator.
        const insp = await this.core.agents.rpc(hostId, { method: 'fs.inspect', params: { path: repo } });
        cwd = insp.repoRoot ?? insp.path;
        if (insp.isGitRepo && insp.hasCommits && codeTask) {
          branch = insp.branch;
          baseSha = task.baseSha ?? insp.head;
          // Whatever is already uncommitted here is the owner's own work in their folder.
          if (task.baseDirty == null) {
            const before = await this.core.agents.rpc(hostId, { method: 'git.status', params: { cwd } });
            task.baseDirty = (before.files ?? []).map((f: any) => f.path);
          }
        } else branch = null;
      } else if (repo && !isAttached) {
        const insp = await this.core.agents.rpc(hostId, { method: 'fs.inspect', params: { path: repo } });
        if (insp.isGitRepo) {
          const paths = this.worktreePaths(insp.repoRoot, employee);
          // The integration branch must exist before anyone branches from it.
          await this.core.agents.rpc(hostId, { method: 'git.worktree.ensure', params: { repo: insp.repoRoot, path: paths.integration, branch: project.integrationBranch, base: project.baseBranch } });
          const wt = await this.core.agents.rpc(hostId, { method: 'git.worktree.ensure', params: { repo: insp.repoRoot, path: paths.employee, branch: `orch/${slugify(employee.name)}/home`, base: project.integrationBranch } });
          cwd = wt.path;
          if (codeTask) {
            const name = task.branch ?? `orch/${slugify(employee.name)}/${task.key.toLowerCase()}-${slugify(task.title, 28)}`;
            const res = await this.core.agents.rpc(hostId, { method: 'git.branch.start', params: { cwd, branch: name, base: project.integrationBranch } });
            branch = res.branch;
            baseSha = task.baseSha ?? res.baseSha;
          }
        } else cwd = insp.path;
      } else {
        const fallback = attached?.cwd ?? employee.workingDir ?? project.repoPath;
        if (!fallback) throw new Error(`${employee.name} has no working directory for project ${project.name}`);
        cwd = fallback;
      }
      if (codeTask) {
        const clash = this.core.tasks.find((t) => t.id !== task.id && t.status === 'IN_PROGRESS' && t.assigneeId !== employee.id && !!t.worktree && path.resolve(t.worktree) === path.resolve(cwd) && !NON_CODE_KINDS.has(t.kind));
        if (clash) {
          const other = this.core.employees.get(clash.assigneeId);
          throw new Error(`${other?.name ?? 'Another employee'} is already changing files in ${cwd} (${clash.key}). Two employees must not edit the same working tree; use a git repository so each gets an isolated worktree, or switch the project to isolated worktrees.`);
        }
      }
      await this.eng.sessions.start(employee.id, { cwd, actor: 'scheduler' });

      task.worktree = cwd;
      task.branch = branch;
      task.baseSha = baseSha;
      task.status = 'IN_PROGRESS';
      task.blockedReason = null;
      task.startedAt = task.startedAt ?? nowIso();
      task.nudges = 0;
      task.progress = { percent: null, note: null, ts: null };
      task.delivery = { status: 'queued', via: null, ts: nowIso(), detail: 'Waiting for the session to be ready for input' };
      this.history(task, `Handed to ${employee.name}`, 'scheduler');
      this.core.put('task', task);

      let text: string;
      if (task.kind === 'review' && task.reviewOf) {
        const target = this.core.tasks.require(task.reviewOf);
        text = reviewPrompt(task, target, project, this.core.employees.get(target.assigneeId)?.name ?? 'a teammate');
        // (First task on this project: what the team has learned, once, ahead of the lessons chosen for this task.)
        const playbook = [this.eng.improver.capture.onboardingBlock(employee, project), this.eng.improver.playbookBlock(employee, project.id, true, task)].filter(Boolean).join('\n\n');
        if (playbook) text += `\n\n${playbook}`;
      } else {
        const deps = task.dependsOn.map((id) => this.core.tasks.get(id)).filter((t): t is Task => !!t);
        const fb: string[] = [];
        if (task.evidence.review?.verdict === 'changes_requested') fb.push(`Review (${task.evidence.review.by === 'owner' ? 'the boss' : (this.core.employees.get(task.evidence.review.reviewerId)?.name ?? 'reviewer')}): ${task.evidence.review.comments}`);
        if (task.evidence.merge && !task.evidence.merge.ok) fb.push(`Merge into ${task.evidence.merge.into} conflicted: ${task.evidence.merge.detail}\nIn your worktree run "git merge ${project.integrationBranch}", resolve the conflicts, commit, re-run the tests and call complete_task again.`);
        text = taskPrompt(task, project, deps, fb.length ? fb.join('\n\n') : null, [this.eng.improver.capture.onboardingBlock(employee, project), this.eng.improver.playbookBlock(employee, project.id, true, task)].filter(Boolean).join('\n\n'));
      }
      this.eng.comms.deliver(employee.id, 'TASK', task.id, { kind: 'task', id: task.id }, text);
    } catch (e) {
      this.fail(task, (e as Error).message);
    }
  }

  onDeliveryState(taskId: string, state: DeliveryState): void {
    const task = this.core.tasks.get(taskId);
    if (!task) return;
    const was = task.delivery.status;
    task.delivery = state;
    this.core.put('task', task);
    const emp = this.core.employees.get(task.assigneeId);
    if (state.status === 'sent' && was !== 'sent') {
      this.core.event({ type: 'task.delivered', source: 'server', summary: `${task.key} was handed to ${emp?.name ?? 'employee'} (${state.via === 'stop_hook' ? 'via Stop hook' : state.via === 'sdk' ? 'through the Agent SDK' : 'typed into the terminal'})`, taskId, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, via: state.via, quiet: true } });
    } else if (state.status === 'confirmed' && was !== 'confirmed') {
      this.core.event({ type: 'task.started', source: 'hook', summary: `${emp?.name ?? 'Employee'} started ${task.key}: ${task.title}`, taskId, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, via: state.via } });
    } else if (state.status === 'failed') {
      this.fail(task, `The task could not be delivered to the session: ${state.detail ?? 'unknown error'}`);
    }
  }

  progress(employee: Employee, note: string, percent: number | undefined): Task | undefined {
    const task = this.currentTask(employee.id);
    if (!task) return undefined;
    task.progress = { percent: typeof percent === 'number' ? Math.max(0, Math.min(100, Math.round(percent))) : task.progress.percent, note, ts: nowIso() };
    task.updatedAt = nowIso();
    this.core.put('task', task);
    this.core.event({
      type: 'task.progress',
      source: 'mcp',
      summary: `${employee.name} on ${task.key}: ${truncate(note, 140)}${task.progress.percent != null ? ` (${task.progress.percent}%)` : ''}`,
      taskId: task.id,
      projectId: task.projectId,
      employeeId: employee.id,
      data: { key: task.key, note, percent: task.progress.percent },
    });
    return task;
  }

  blockFromAgent(employee: Employee, reason: string, needs: string | undefined): Task | undefined {
    const task = this.currentTask(employee.id);
    const session = this.core.runningSessionOf(employee.id);
    if (session) this.eng.sessions.setActivity(session, 'blocked', truncate(reason, 120));
    if (!task) {
      this.eng.comms.notify({ kind: 'blocked', severity: 'critical', title: `${employee.name} is blocked`, body: `${reason}${needs ? `\nNeeds: ${needs}` : ''}`, employeeId: employee.id });
      return undefined;
    }
    task.status = 'BLOCKED';
    task.friction.blockers++;
    task.blockedReason = needs ? `${reason} — needs: ${needs}` : reason;
    this.history(task, `Blocked by ${employee.name}: ${reason}`, `employee:${employee.name}`);
    this.core.put('task', task);
    this.core.event({ type: 'task.blocked', source: 'mcp', summary: `${employee.name} is blocked on ${task.key}: ${truncate(reason, 140)}`, taskId: task.id, projectId: task.projectId, employeeId: employee.id, data: { key: task.key, reason, needs: needs ?? null } });
    this.eng.comms.notify({ kind: 'blocked', severity: 'critical', title: `${employee.name} is blocked on ${task.key}`, body: task.blockedReason, employeeId: employee.id, taskId: task.id, projectId: task.projectId });
    this.schedule();
    return task;
  }

  /**
   * A technical handoff: an employee passes the task they are working on to a teammate, with
   * notes on where it stands. The work so far stays on the task branch (it must be committed),
   * and the teammate continues from it when they are free.
   */
  async handOff(from: Employee, toRef: string, notes: string): Promise<{ text: string; isError?: boolean }> {
    const task = this.currentTask(from.id);
    if (!task || task.status !== 'IN_PROGRESS') return { text: 'You have no task in progress to hand off.', isError: true };
    if (notes.trim().length < 20) return { text: 'Write real handoff notes: what is done, what remains, and anything the next person must know.', isError: true };
    const to = this.eng.comms.resolveTeammate(from, toRef);
    if (!to || to.archived) return { text: `No teammate matches "${toRef}". Use get_team.`, isError: true };
    if (!to.hostId) return { text: `${to.name} has no machine to work on; choose someone else or tell the boss.`, isError: true };
    if (to.projectId && to.projectId !== task.projectId) return { text: `${to.name} works on another project; choose a teammate on this one or ask the boss.`, isError: true };
    if (this.verifying.has(task.id)) return { text: `Verification of ${task.key} is running; wait for its result.`, isError: true };
    const project = this.core.projects.require(task.projectId);
    const codeTask = !NON_CODE_KINDS.has(task.kind);
    const hostId = this.core.runningSessionOf(from.id)?.hostId ?? from.hostId;
    if (codeTask && task.worktree && task.branch && hostId) {
      if (!this.core.agents.isOnline(hostId)) return { text: 'Your host is not reachable by Orchestrator right now; try again shortly.', isError: true };
      const st = await this.core.agents.rpc(hostId, { method: 'git.status', params: { cwd: task.worktree } });
      const mine = (st.files ?? []).filter((f: any) => !(task.baseDirty ?? []).includes(f.path));
      if (mine.length) return { text: `Commit your work before handing off — ${to.name} continues from the branch, not from your uncommitted files (${mine.slice(0, 5).map((f: any) => f.path).join(', ')}${mine.length > 5 ? ', …' : ''}).`, isError: true };
      // In an isolated worktree, step off the task branch so the teammate's worktree can check it out.
      if (project.workspace !== 'in_place' && st.branch === task.branch && /^orch\//.test(task.branch)) {
        await this.core.agents.rpc(hostId, { method: 'git.branch.start', params: { cwd: task.worktree, branch: `orch/${slugify(from.name)}/home`, base: project.integrationBranch } });
      }
    }
    this.eng.comms.cancelFor({ kind: 'task', id: task.id });
    const note = truncate(notes.trim(), 4000);
    task.assigneeId = to.id;
    task.status = 'READY';
    task.released = true;
    task.worktree = null;
    task.nudges = 0;
    task.delivery = { status: 'none', via: null, ts: null, detail: null };
    task.description = `${task.description}\n\nHandoff from ${from.name} (${nowIso().slice(0, 16).replace('T', ' ')} UTC)${task.branch ? `, work so far is on branch ${task.branch}` : ''}:\n${note}`.trim();
    this.history(task, `Handed off by ${from.name} to ${to.name}`, `employee:${from.name}`);
    task.updatedAt = nowIso();
    this.core.put('task', task);
    this.core.event({ type: 'task.handoff', source: 'mcp', summary: `${from.name} handed ${task.key} off to ${to.name}`, taskId: task.id, projectId: task.projectId, employeeId: from.id, data: { key: task.key, from: from.id, to: to.id, notes: redactSecrets(truncate(note, 600)), branch: task.branch } });
    this.emitAssigned(task, `employee:${from.name}`);
    this.eng.comms.sendMessage({ from: { kind: 'employee', id: from.id, name: `${from.name} (${from.title})` }, toEmployeeId: to.id, kind: 'handoff', taskId: task.id, body: `I am handing ${task.key} "${task.title}" over to you. The task itself reaches you when you are free; my notes:\n${note}` });
    const session = this.core.runningSessionOf(from.id);
    if (session) this.eng.sessions.setActivity(session, 'idle', null);
    this.schedule();
    return { text: `${task.key} now belongs to ${to.name}, with your notes. Stop working on it; you will get your next task when one is ready.` };
  }

  /** The owner cleared a blocker: the task goes back to the employee with the owner's note. */
  /** `by`: the employee who resolved the blocker, when it was not the owner (it is then their message the assignee reads). */
  unblock(taskId: string, note: string, actor = 'owner', by?: Employee): Task {
    const task = this.core.tasks.require(taskId);
    if (task.status !== 'BLOCKED') throw new EngineError(`${task.key} is not blocked`);
    const employee = this.core.employees.get(task.assigneeId);
    const previous = task.blockedReason;
    task.blockedReason = null;
    this.eng.comms.resolveNotifications((n) => n.taskId === task.id && (n.kind === 'blocked' || n.kind === 'merge_conflict'));
    const session = employee ? this.core.runningSessionOf(employee.id) : undefined;
    const stillTheirs = employee && session && task.worktree && path.resolve(session.cwd) === path.resolve(task.worktree) && !this.currentTask(employee.id);
    if (stillTheirs && task.delivery.status !== 'none') {
      // Same session, same workspace: resume in place with the owner's note.
      task.status = 'IN_PROGRESS';
      this.history(task, `Unblocked: ${note}`, actor);
      this.core.put('task', task);
      this.eng.comms.sendMessage({ from: by ? { kind: 'employee', id: by.id, name: `${by.name} (${by.title})` } : { kind: 'owner', id: null, name: 'the boss' }, toEmployeeId: employee!.id, body: `${task.key} is unblocked (was: ${previous ?? 'blocked'}). ${note}\nContinue the task.`, kind: 'system', taskId: task.id });
      if (session!.activity === 'blocked') this.eng.sessions.setActivity(session!, 'idle', null);
    } else {
      task.status = 'READY';
      task.released = true;
      if (note) task.description = `${task.description}\n\nNote from ${by ? by.name : 'the boss'} after a blocker (${previous ?? 'blocked'}): ${note}`.trim();
      this.history(task, `Unblocked and requeued: ${note}`, actor);
      this.core.put('task', task);
    }
    this.core.event({ type: 'task.unblocked', source: by ? 'mcp' : 'owner', summary: by ? `${by.name} unblocked ${task.key}` : `${task.key} was unblocked`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, note } });
    this.schedule();
    return task;
  }

  // ────────────────────── completion & verification ────────────────

  /**
   * An agent called complete_task. Returns the text the agent receives; a
   * failed check comes back as a tool error so the agent keeps working.
   */
  async completeFromAgent(employee: Employee, args: { summary: string; tests_run?: string; no_code_changes?: boolean }): Promise<{ text: string; isError?: boolean }> {
    const task = this.currentTask(employee.id);
    if (!task) return { text: 'You have no task in progress. Use get_current_task or get_available_tasks.', isError: true };
    if (this.verifying.has(task.id)) return { text: `Verification of ${task.key} is already running; wait for its result.`, isError: true };
    const project = this.core.projects.require(task.projectId);
    const hostId = this.core.runningSessionOf(employee.id)?.hostId ?? employee.hostId;
    if (!hostId || !this.core.agents.isOnline(hostId)) return { text: 'Your host is not reachable by Orchestrator right now; try complete_task again shortly.', isError: true };
    this.verifying.add(task.id);
    try {
      task.evidence.summary = args.summary;
      task.evidence.reportedTests = args.tests_run ?? null;
      const codeTask = !NON_CODE_KINDS.has(task.kind);
      const cwd = task.worktree;

      if (task.kind === 'review' && task.reviewOf) {
        const target = this.core.tasks.get(task.reviewOf);
        if (target && target.status === 'REVIEW' && !target.evidence.review) {
          return { text: `You have not submitted your verdict yet. Call submit_review for ${target.key} first, then complete_task.`, isError: true };
        }
      }

      if (cwd && task.branch) {
        const st = await this.core.agents.rpc(hostId, { method: 'git.status', params: { cwd } });
        if (st.branch !== task.branch) {
          return { text: `Not complete: your worktree is on branch "${st.branch}" but ${task.key} must be on "${task.branch}". Switch back with: git switch ${task.branch}`, isError: true };
        }
        if (project.workspace === 'in_place') {
          // The owner's folder: only what became uncommitted during this task counts. Files that
          // were already uncommitted before it started are the owner's and are never the employee's to tidy.
          const theirs = new Set(task.baseDirty ?? []);
          const mine = st.files.filter((f: any) => !theirs.has(f.path));
          if (mine.length) {
            const files = mine.slice(0, 12).map((f: any) => `${f.status} ${f.path}`).join('\n');
            return {
              text: `Not complete: these files changed during this task and are not committed.\n${files}\nCommit what belongs to the task, then call complete_task again. Do not commit, change or delete files that were already uncommitted in this folder before you started — they are the owner's.`,
              isError: true,
            };
          }
        } else if (st.dirty) {
          const files = st.files.slice(0, 12).map((f: any) => `${f.status} ${f.path}`).join('\n');
          return { text: `Not complete: there are uncommitted changes in your worktree.\n${files}\nCommit what belongs to the task (or remove stray files), then call complete_task again.`, isError: true };
        }
        const base = task.baseSha ?? project.integrationBranch;
        const log = await this.core.agents.rpc(hostId, { method: 'git.log', params: { cwd, range: `${base}..HEAD`, max: 100 } });
        task.evidence.commits = log.commits ?? [];
        if (!task.evidence.commits.length && codeTask && !args.no_code_changes) {
          return { text: `Not complete: there are no commits on "${task.branch}" since the task started. Commit your work, or — only if the task truly needed no repository changes — call complete_task with no_code_changes=true and explain why in the summary.`, isError: true };
        }
        const diff = await this.core.agents.rpc(hostId, { method: 'git.diff', params: { cwd, base, maxBytes: 2000 } });
        task.evidence.filesChanged = diff.files ?? [];
        task.evidence.diffStat = diff.stat || null;
      }

      const command = codeTask ? (task.verifyCommand ?? project.verifyCommand) : null;
      if (command && cwd) {
        this.core.put('task', task);
        this.core.event({ type: 'task.verifying', source: 'server', summary: `Verifying ${task.key}: ${command}`, taskId: task.id, projectId: project.id, employeeId: employee.id, data: { key: task.key, command } });
        const timeoutMs = Math.max(5, project.verifyTimeoutSec) * 1000;
        let res: any;
        try {
          res = await this.core.agents.rpc(hostId, { method: 'verify.run', params: { cwd, command, timeoutMs } }, timeoutMs + 20000);
        } catch (e) {
          task.evidence.verification = { ts: nowIso(), command, exitCode: null, passed: null, outputTail: (e as Error).message, durationMs: null, provenance: 'unavailable' };
          this.core.put('task', task);
          return { text: `Orchestrator could not run the verification command (${(e as Error).message}). Tell the boss with report_blocker if this persists.`, isError: true };
        }
        const passed = res.exitCode === 0 && !res.timedOut;
        task.evidence.verification = { ts: nowIso(), command, exitCode: res.exitCode, passed, outputTail: res.outputTail, durationMs: res.durationMs, provenance: 'measured' };
        this.core.company.verificationsRun++;
        if (!passed) {
          task.attempts++;
          task.friction.failedVerifications++;
          this.history(task, `Verification failed (${res.timedOut ? 'timed out' : `exit ${res.exitCode}`})`, 'orchestrator');
          this.core.put('task', task);
          this.core.saveCompany();
          this.core.event({ type: 'task.verification_failed', source: 'server', summary: `${task.key} failed verification (${res.timedOut ? 'timeout' : `exit ${res.exitCode}`})`, taskId: task.id, projectId: project.id, employeeId: employee.id, data: { key: task.key, command, exitCode: res.exitCode, timedOut: res.timedOut, outputTail: truncate(res.outputTail, 1500) } });
          // The same failure on another task of this project is a fact about the project, not about this task.
          this.eng.improver.capture.onVerificationFailed(task, project, command, res);
          this.eng.comms.resolveNotifications((n) => n.kind === 'test_failure' && n.taskId === task.id);
          this.eng.comms.notify({ kind: 'test_failure', severity: 'warning', title: `${task.key} failed verification`, body: `${employee.name}'s work did not pass "${command}". They have been told to fix it.`, taskId: task.id, projectId: project.id, employeeId: employee.id });
          return {
            text: `Verification FAILED for ${task.key}. Orchestrator ran "${command}" in your worktree: ${res.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exit code ${res.exitCode}`}.\n\nOutput (tail):\n${res.outputTail}\n\nThe task is not complete. Fix the problem, commit, and call complete_task again.`,
            isError: true,
          };
        }
        this.core.company.testsPassed++;
        this.core.saveCompany();
        this.eng.comms.resolveNotifications((n) => n.kind === 'test_failure' && n.taskId === task.id);
      } else {
        task.evidence.verification = { ts: nowIso(), command: null, exitCode: null, passed: null, outputTail: '', durationMs: null, provenance: 'unavailable' };
      }

      task.progress = { percent: 100, note: 'Completion reported', ts: nowIso() };
      if (task.requiresReview && task.kind !== 'review' && task.evidence.review?.verdict !== 'approved') {
        task.status = 'REVIEW';
        task.evidence.review = null;
        this.history(task, 'Verified; waiting for review', 'orchestrator');
        this.core.put('task', task);
        const reviewer = this.requestReview(task, null);
        this.afterEmployeeFreed(employee);
        return { text: `${task.key} passed Orchestrator's checks and is now waiting for review by ${reviewer ? reviewer.name : 'the boss'}. You are free; wait for the next task or for review feedback.` };
      }
      await this.finalize(task);
      this.afterEmployeeFreed(employee);
      if (task.status === 'DONE') return { text: `${task.key} is verified and DONE${task.evidence.merge?.ok ? ` (merged into ${task.evidence.merge.into})` : ''}. Good work. Wait for the next task.` };
      return { text: `${task.key} passed verification, but merging "${task.branch}" into ${project.integrationBranch} conflicted (${task.evidence.merge?.detail ?? ''}). The boss has been asked how to proceed; wait for instructions.` };
    } finally {
      this.verifying.delete(task.id);
    }
  }

  private afterEmployeeFreed(employee: Employee): void {
    const s = this.core.runningSessionOf(employee.id);
    if (s && !this.currentTask(employee.id)) {
      const done = this.core.tasks.find((t) => t.assigneeId === employee.id && t.status === 'DONE' && !!t.completedAt && Date.now() - Date.parse(t.completedAt) < 5000);
      if (done) {
        this.eng.sessions.setActivity(s, 'task_complete', `${done.key} completed`);
        const prev = this.celebrateTimers.get(employee.id);
        if (prev) clearTimeout(prev);
        const timer = setTimeout(() => {
          this.celebrateTimers.delete(employee.id);
          const cur = this.core.runningSessionOf(employee.id);
          if (cur && cur.activity === 'task_complete') this.eng.sessions.setActivity(cur, 'idle', null);
        }, 8000);
        timer.unref?.();
        this.celebrateTimers.set(employee.id, timer);
      }
    }
    this.schedule();
  }

  // ───────────────────── integration branch controls ─────────────────────

  /** The machine and repository a shared project's integration branch lives on. */
  private integrationHome(project: Project): { hostId: string; repo: string } {
    if (project.workspace === 'in_place') throw new EngineError(`${project.name} is worked on in place: there is no integration branch to manage`);
    if (!project.repoPath || !project.hostId) throw new EngineError(`${project.name} has no repository on a machine`);
    if (!this.core.agents.isOnline(project.hostId)) throw new EngineError(`the machine that holds ${project.name} is offline`, 502);
    return { hostId: project.hostId, repo: project.repoPath };
  }

  private integrationPath(repoRoot: string): string {
    return path.join(path.dirname(repoRoot), '.orchestrator-worktrees', path.basename(repoRoot), '_integration');
  }

  /**
   * Integration testing: run the project's verification command on the integration branch itself.
   * A task can pass alone and still break the whole; this is where that shows.
   */
  async testIntegration(project: Project, hostId: string, repoRoot: string, after: string, taskId: string | null = null): Promise<NonNullable<Project['integration']>['lastTest']> {
    const command = project.verifyCommand;
    if (!command || project.policy.integrationTests === false) return null;
    const cwd = this.integrationPath(repoRoot);
    const timeoutMs = Math.max(5, project.verifyTimeoutSec) * 1000;
    return this.chainMerge(`${hostId}:${repoRoot}`, async () => {
      let lastTest: NonNullable<Project['integration']>['lastTest'];
      try {
        const st = await this.core.agents.rpc(hostId, { method: 'git.status', params: { cwd } });
        const res = await this.core.agents.rpc(hostId, { method: 'verify.run', params: { cwd, command, timeoutMs } }, timeoutMs + 20000);
        lastTest = { ts: nowIso(), sha: st.head ?? null, passed: res.exitCode === 0 && !res.timedOut, command, outputTail: res.outputTail, durationMs: res.durationMs, after };
      } catch (e) {
        lastTest = { ts: nowIso(), sha: null, passed: null, command, outputTail: (e as Error).message, durationMs: null, after };
      }
      const fresh = this.core.projects.get(project.id) ?? project;
      fresh.integration = { lastPromotion: fresh.integration?.lastPromotion ?? null, lastTest };
      this.core.put('project', fresh);
      const verdict = lastTest.passed ? 'passed' : lastTest.passed === false ? 'failed' : 'could not run';
      this.core.event({ type: 'project.integration_tested', source: 'server', summary: `${fresh.name}: integration tests ${verdict} ${after}`, projectId: fresh.id, taskId, data: { passed: lastTest.passed, sha: lastTest.sha, command, after, durationMs: lastTest.durationMs } });
      const mine = (n: { kind: string; projectId: string | null; title: string }) => n.kind === 'test_failure' && n.projectId === fresh.id && /integration branch/.test(n.title);
      if (lastTest.passed === false) {
        if (!this.core.notifications.find((n) => !n.resolvedAt && mine(n))) {
          this.eng.comms.notify({ kind: 'test_failure', severity: 'critical', title: `${fresh.name}: the integration branch fails its tests`, body: `"${command}" failed on ${fresh.integrationBranch} ${after}. Each task passed on its own; together they do not.\n${truncate(lastTest.outputTail, 600)}`, projectId: fresh.id, taskId });
        }
      } else if (lastTest.passed) this.eng.comms.resolveNotifications(mine);
      return lastTest;
    });
  }

  /** How the integration branch stands against the base branch, with its last test run and promotion. */
  async integrationView(projectId: string): Promise<Record<string, unknown>> {
    const project = this.core.projects.require(projectId);
    const { hostId, repo } = this.integrationHome(project);
    const insp = await this.core.agents.rpc(hostId, { method: 'fs.inspect', params: { path: repo } });
    if (!insp.isGitRepo) throw new EngineError(`${repo} is not a git repository`);
    const status = await this.core.agents.rpc(hostId, { method: 'git.integration.status', params: { repo: insp.repoRoot, base: project.baseBranch, integration: project.integrationBranch } });
    return { ...status, lastTest: project.integration?.lastTest ?? null, lastPromotion: project.integration?.lastPromotion ?? null, integrationTests: project.policy.integrationTests !== false && !!project.verifyCommand };
  }

  /** Bring what is on the base branch into the integration branch (a real merge, aborted on conflict), then test it. */
  async syncIntegration(projectId: string, actor = 'owner'): Promise<Record<string, unknown>> {
    const project = this.core.projects.require(projectId);
    const { hostId, repo } = this.integrationHome(project);
    const insp = await this.core.agents.rpc(hostId, { method: 'fs.inspect', params: { path: repo } });
    const repoRoot = insp.repoRoot ?? repo;
    const res = await this.chainMerge(`${hostId}:${repoRoot}`, () =>
      this.core.agents.rpc(hostId, { method: 'git.merge', params: { repo: repoRoot, worktree: this.integrationPath(repoRoot), into: project.integrationBranch, base: project.baseBranch, branch: project.baseBranch, message: `Merge ${project.baseBranch} into ${project.integrationBranch}` } }),
    );
    this.core.audit(actor, 'project.integration_synced', projectId, { ok: res.ok, sha: res.sha, conflicts: res.conflicts });
    this.core.event({ type: 'project.integration_synced', source: 'owner', summary: res.ok ? `${project.name}: ${project.baseBranch} ${res.alreadyMerged ? 'was already in' : 'merged into'} ${project.integrationBranch}` : `${project.name}: ${project.baseBranch} conflicts with ${project.integrationBranch}`, projectId, data: { ok: res.ok, sha: res.sha, conflicts: res.conflicts, alreadyMerged: res.alreadyMerged } });
    if (!res.ok) throw new EngineError(`${project.baseBranch} conflicts with ${project.integrationBranch}${res.conflicts?.length ? ` in ${res.conflicts.join(', ')}` : ''}. The merge was aborted; nothing changed.`, 409);
    const lastTest = res.alreadyMerged ? (project.integration?.lastTest ?? null) : await this.testIntegration(project, hostId, repoRoot, `after bringing in ${project.baseBranch}`);
    return { ...res, lastTest };
  }

  /** Run the integration tests now, on the owner's request. */
  async runIntegrationTests(projectId: string): Promise<unknown> {
    const project = this.core.projects.require(projectId);
    const { hostId, repo } = this.integrationHome(project);
    if (!project.verifyCommand) throw new EngineError(`${project.name} has no verification command`);
    const insp = await this.core.agents.rpc(hostId, { method: 'fs.inspect', params: { path: repo } });
    return this.testIntegration({ ...project, policy: { ...project.policy, integrationTests: true } }, hostId, insp.repoRoot ?? repo, 'on request');
  }

  /**
   * Promote the integration branch to the base branch: a fast-forward of the base, on the owner's
   * word. Refused while the integration tests fail (unless forced), and never pushed anywhere.
   */
  async promote(projectId: string, opts: { force?: boolean } = {}, actor = 'owner'): Promise<Project> {
    const project = this.core.projects.require(projectId);
    const { hostId, repo } = this.integrationHome(project);
    if (project.integration?.lastTest?.passed === false && !opts.force) throw new EngineError(`the integration branch failed its tests (${project.integration.lastTest.after}); fix that first, or promote anyway on purpose`, 409);
    const insp = await this.core.agents.rpc(hostId, { method: 'fs.inspect', params: { path: repo } });
    const repoRoot = insp.repoRoot ?? repo;
    const res = await this.chainMerge(`${hostId}:${repoRoot}`, () => this.core.agents.rpc(hostId, { method: 'git.promote', params: { repo: repoRoot, base: project.baseBranch, integration: project.integrationBranch } }));
    project.integration = { lastTest: project.integration?.lastTest ?? null, lastPromotion: { ts: nowIso(), sha: res.sha, commits: res.commits, by: actor } };
    this.core.put('project', project);
    this.core.audit(actor, 'project.promoted', projectId, { sha: res.sha, commits: res.commits, from: res.from, forced: !!opts.force, base: project.baseBranch });
    this.core.event({ type: 'project.promoted', source: 'owner', summary: `${project.name}: ${res.commits} commit${res.commits === 1 ? '' : 's'} promoted from ${project.integrationBranch} to ${project.baseBranch}`, projectId, data: { sha: res.sha, commits: res.commits, base: project.baseBranch, forced: !!opts.force } });
    return project;
  }

  private chainMerge<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mergeChains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.mergeChains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Merge (when applicable) and mark DONE. A conflicting merge is reported, never forced. */
  async finalize(task: Task): Promise<void> {
    const project = this.core.projects.require(task.projectId);
    const employee = this.core.employees.get(task.assigneeId);
    const hostId = employee ? (this.core.runningSessionOf(employee.id)?.hostId ?? employee.hostId) : project.hostId;
    // In-place projects have nothing to merge: the commits are already on the folder's own branch.
    const mergeable = project.workspace !== 'in_place' && !!task.branch && !!task.worktree && task.evidence.commits.length > 0 && project.policy.autoMerge && !NON_CODE_KINDS.has(task.kind);
    if (mergeable && hostId && employee) {
      const repo = this.repoFor(project, employee);
      if (repo && this.core.agents.isOnline(hostId)) {
        const insp = await this.core.agents.rpc(hostId, { method: 'fs.inspect', params: { path: repo } });
        const paths = this.worktreePaths(insp.repoRoot ?? repo, employee);
        const res = await this.chainMerge(`${hostId}:${insp.repoRoot ?? repo}`, () =>
          this.core.agents.rpc(hostId, {
            method: 'git.merge',
            params: { repo: insp.repoRoot ?? repo, worktree: paths.integration, into: project.integrationBranch, base: project.baseBranch, branch: task.branch!, message: `Merge ${task.key}: ${task.title}` },
          }),
        ).catch((e) => ({ ok: false, sha: null, into: project.integrationBranch, conflicts: [], detail: (e as Error).message, alreadyMerged: false }));
        task.evidence.merge = { ts: nowIso(), ok: res.ok, sha: res.sha, into: project.integrationBranch, detail: res.ok ? res.detail : `${res.conflicts?.length ? `Conflicts in: ${res.conflicts.join(', ')}. ` : ''}${res.detail}` };
        if (!res.ok) {
          task.friction.mergeConflicts++;
          this.core.company.mergeConflicts++;
          this.core.saveCompany();
          task.status = 'BLOCKED';
          task.blockedReason = `Merge into ${project.integrationBranch} conflicted${res.conflicts?.length ? ` in ${res.conflicts.join(', ')}` : ''}`;
          this.history(task, task.blockedReason, 'orchestrator');
          this.core.put('task', task);
          this.core.event({ type: 'task.merge_conflict', source: 'server', summary: `${task.key} could not be merged: conflicts${res.conflicts?.length ? ` in ${res.conflicts.join(', ')}` : ''}`, taskId: task.id, projectId: project.id, employeeId: task.assigneeId, data: { key: task.key, conflicts: res.conflicts ?? [], detail: res.detail } });
          this.eng.comms.createQuestion({
            kind: 'merge_conflict',
            channel: 'system',
            employee: employee ?? null,
            session: employee ? (this.core.runningSessionOf(employee.id) ?? null) : null,
            text: `${task.key} "${task.title}" passed verification but its branch conflicts with ${project.integrationBranch}. How should it be resolved?`,
            context: `Branch: ${task.branch}\n${task.evidence.merge.detail}\nThe merge was aborted; nothing was overwritten.`,
            why: 'Work from another employee changed the same lines. Tasks that depend on this one stay waiting until it is merged.',
            options: [
              { label: `Have ${employee?.name ?? 'the author'} resolve it`, description: 'They merge the integration branch into their task branch, resolve the conflicts, re-test and resubmit.', consequence: 'The task goes back in progress.' },
              { label: 'I will resolve it myself', description: 'Leave the task blocked; resolve in the terminal, then use Retry merge.' },
            ],
            taskId: task.id,
            projectId: project.id,
            quietEvent: true,
          });
          return;
        }
        this.core.company.mergesSucceeded++;
        // The task passed on its own branch; now check the integration branch with it merged in.
        if (!res.alreadyMerged) void this.testIntegration(project, hostId, insp.repoRoot ?? repo, `after merging ${task.key}`, task.id).catch(() => undefined);
        this.core.event({ type: 'task.merged', source: 'server', summary: `${task.key} merged into ${project.integrationBranch}`, taskId: task.id, projectId: project.id, employeeId: task.assigneeId, data: { key: task.key, sha: res.sha, alreadyMerged: res.alreadyMerged } });
      }
    }
    task.status = 'DONE';
    task.blockedReason = null;
    task.completedAt = nowIso();
    this.history(task, 'Verified and completed', 'orchestrator');
    this.core.put('task', task);
    const v = task.evidence.verification;
    this.core.event({
      type: 'task.completed',
      source: 'server',
      summary: `${employee?.name ?? 'Employee'} completed ${task.key}: ${task.title}`,
      taskId: task.id,
      projectId: project.id,
      employeeId: task.assigneeId,
      data: { key: task.key, verified: v?.provenance === 'measured' ? v.passed : null, commits: task.evidence.commits.length, merged: task.evidence.merge?.ok ?? null },
    });
    this.eng.comms.resolveNotifications((n) => n.taskId === task.id && n.kind !== 'task_completed');
    if (task.kind !== 'review') {
      this.eng.comms.notify({
        kind: 'task_completed',
        severity: 'success',
        title: `${task.key} completed`,
        body: `${employee?.name ?? 'Employee'}: ${truncate(task.evidence.summary ?? task.title, 200)}`,
        taskId: task.id,
        projectId: project.id,
        employeeId: task.assigneeId,
      });
    }
    this.core.company.tasksCompleted++;
    if (task.kind === 'bug') this.core.company.bugsResolved++;
    if (task.kind === 'refactor' || task.kind === 'chore') this.core.company.debtReduced++;
    this.core.company.agentWorkMs += timeInProgress(task);
    this.core.saveCompany();
    for (const entry of xpForCompletedTask(task)) this.awardXp(entry);
    this.eng.comms.awardAssistsFor(task.id);
    // Self-improvement: reflect on this task and re-read the record for process changes.
    this.eng.improver.afterTask(task);
    this.checkProjectDelivered(project);
    this.checkMilestones();
    this.schedule();
  }

  /** Owner action after resolving a conflict by hand. */
  async retryMerge(taskId: string, actor = 'owner'): Promise<Task> {
    const task = this.core.tasks.require(taskId);
    if (task.status !== 'BLOCKED' || !task.evidence.merge || task.evidence.merge.ok) throw new EngineError(`${task.key} is not waiting on a merge`);
    this.core.audit(actor, 'task.retry_merge', taskId, { key: task.key });
    await this.finalize(task);
    return task;
  }

  private checkProjectDelivered(project: Project): void {
    if (project.deliveredAt) return;
    const tasks = this.core.tasks.filter((t) => t.projectId === project.id && t.released && t.kind !== 'review');
    if (!tasks.length || tasks.some((t) => t.status !== 'DONE')) return;
    if (this.core.tasks.find((t) => t.projectId === project.id && !t.released)) return;
    project.deliveredAt = nowIso();
    this.core.put('project', project);
    this.core.company.projectsDelivered++;
    this.core.saveCompany();
    this.core.event({ type: 'project.updated', source: 'server', summary: `Project "${project.name}": every released task is verified done`, projectId: project.id, data: { delivered: true, tasks: tasks.length } });
    this.eng.comms.notify({ kind: 'milestone', severity: 'success', title: `${project.name}: all tasks done`, body: `${tasks.length} task${tasks.length === 1 ? '' : 's'} verified and completed.`, projectId: project.id });
  }

  // ───────────────────────────── review ────────────────────────────

  private pickReviewer(task: Task): Employee | undefined {
    const preferred = task.kind === 'security' ? ['security', 'reviewer', 'architect'] : ['reviewer', 'architect', 'security', 'qa'];
    const pool = this.core.employees.filter((e) => !e.archived && e.id !== task.assigneeId && preferred.includes(e.roleKey) && !!e.hostId && e.schedule.available && (e.projectId === task.projectId || e.projectId === null));
    pool.sort((a, b) => preferred.indexOf(a.roleKey) - preferred.indexOf(b.roleKey));
    return pool[0];
  }

  /** Ask for a review of a task. Returns the reviewing employee, or null when the owner reviews. */
  requestReview(task: Task, reviewerRef: string | null, notes?: string): Employee | null {
    const author = this.core.employees.get(task.assigneeId);
    let reviewer: Employee | undefined;
    if (reviewerRef && author) reviewer = this.eng.comms.resolveTeammate(author, reviewerRef);
    reviewer = reviewer ?? this.core.employees.get(task.reviewerId) ?? this.pickReviewer(task);
    if (reviewer && reviewer.id === task.assigneeId) reviewer = undefined;
    this.core.company.reviewsRequested++;
    this.core.saveCompany();
    this.core.event({
      type: 'task.review_requested',
      source: 'server',
      summary: `${task.key} is waiting for review by ${reviewer?.name ?? 'the boss'}`,
      taskId: task.id,
      projectId: task.projectId,
      employeeId: task.assigneeId,
      data: { key: task.key, reviewerId: reviewer?.id ?? null, fromEmployeeId: task.assigneeId, toEmployeeId: reviewer?.id ?? null },
    });
    if (!reviewer) {
      this.eng.comms.notify({ kind: 'review', severity: 'warning', title: `${task.key} needs your review`, body: `${author?.name ?? 'An employee'} finished "${task.title}". No reviewer is on the team, so it is waiting for you.`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId });
      return null;
    }
    task.reviewerId = reviewer.id;
    this.core.put('task', task);
    const open = this.core.tasks.find((t) => t.reviewOf === task.id && t.status !== 'DONE');
    if (!open) {
      this.createTask(
        {
          projectId: task.projectId,
          title: `Review ${task.key}: ${truncate(task.title, 60)}`,
          description: `Review the work for ${task.key}.${notes ? `\nFocus: ${notes}` : ''}`,
          kind: 'review',
          priority: 'high',
          assigneeId: reviewer.id,
          reviewOf: task.id,
          requiresReview: false,
          released: true,
        },
        'orchestrator',
      );
    }
    return reviewer;
  }

  async submitReview(by: Employee | 'owner', taskRef: string, verdict: 'approve' | 'request_changes', comments: string): Promise<Task> {
    const task = this.taskByKey(taskRef, by === 'owner' ? null : by.projectId);
    if (!task) throw new EngineError(`no task "${taskRef}"`);
    if (task.status !== 'REVIEW') throw new EngineError(`${task.key} is not waiting for review (status ${task.status})`);
    if (by !== 'owner') {
      if (by.id === task.assigneeId) throw new EngineError('you cannot review your own task');
      const assigned = task.reviewerId === by.id || !!this.core.tasks.find((t) => t.reviewOf === task.id && t.assigneeId === by.id);
      // With the board in the employees' hands, any colleague may review finished work — never its own author.
      if (!assigned && this.core.settings.employeesManageBoard === false) throw new EngineError(`you were not asked to review ${task.key}`);
      if (!this.canSee(by, task)) throw new EngineError(`no task "${taskRef}"`);
    }
    const approved = verdict === 'approve';
    task.evidence.review = { reviewerId: by === 'owner' ? null : by.id, verdict: approved ? 'approved' : 'changes_requested', comments, ts: nowIso(), by: by === 'owner' ? 'owner' : 'employee' };
    this.core.company.reviewsCompleted++;
    this.core.saveCompany();
    const reviewerName = by === 'owner' ? 'The boss' : by.name;
    this.core.event({
      type: 'task.review_completed',
      source: by === 'owner' ? 'owner' : 'mcp',
      summary: `${reviewerName} ${approved ? 'approved' : 'requested changes on'} ${task.key}`,
      taskId: task.id,
      projectId: task.projectId,
      employeeId: by === 'owner' ? task.assigneeId : by.id,
      data: { key: task.key, verdict: task.evidence.review.verdict, comments: truncate(comments, 600), reviewerId: by === 'owner' ? null : by.id },
    });
    this.eng.comms.resolveNotifications((n) => n.kind === 'review' && n.taskId === task.id);
    if (by !== 'owner') this.awardXp(xpForReview(by.id, task));
    else {
      // The owner reviewed it: an employee review still queued for it is no longer needed.
      for (const r of this.core.tasks.filter((t) => t.reviewOf === task.id && (t.status === 'READY' || t.status === 'BACKLOG'))) this.core.remove('task', r.id);
    }
    if (approved) {
      this.history(task, `Review approved by ${reviewerName}`, reviewerName);
      await this.finalize(task);
    } else {
      task.status = 'READY';
      task.released = true;
      task.attempts++;
      task.friction.reviewRejections++;
      if (PRIORITY_ORDER[task.priority] > PRIORITY_ORDER.high) task.priority = 'high';
      this.history(task, `Changes requested by ${reviewerName}: ${truncate(comments, 200)}`, reviewerName);
      this.core.put('task', task);
      // The owner's own words on rejected work are a lesson candidate for its author.
      if (by === 'owner') this.eng.improver.capture.onReviewRejected(task, comments);
      this.schedule();
    }
    return task;
  }

  // ─────────────────────────── planning ────────────────────────────

  /** Real tasks created from an agent's plan or a meeting's outcome. */
  proposeTasks(by: Employee, projectId: string, specs: ProposedTask[], rationale: string | undefined, origin: string): Task[] {
    return this.propose(by, projectId, specs, rationale, origin).created;
  }

  /**
   * Tasks proposed by an employee. One that carries a `dedupe_key` this project already has a task for (whatever
   * became of that task) is not added again. One that carries a new key waits in the backlog for the owner's
   * go-ahead even where the project assigns work automatically: such tasks come from checks that repeat by
   * themselves, and a check that misreads a page must not start work on its own.
   */
  propose(by: Employee, projectId: string, specs: ProposedTask[], rationale: string | undefined, origin: string): { created: Task[]; existing: Task[] } {
    const project = this.core.projects.require(projectId);
    if (!Array.isArray(specs) || !specs.length) throw new EngineError('propose at least one task');
    if (specs.length > 40) throw new EngineError('too many tasks in one proposal (max 40)');
    const created: Task[] = [];
    const existing: Task[] = [];
    // By position in the proposal, so "after the second task" still means that one when another was already there.
    const at: Task[] = [];
    const auto = project.policy.autoAssign;
    for (const [i, spec] of specs.entries()) {
      if (!spec?.title?.trim()) throw new EngineError(`task ${i} has no title`);
      const key = dedupeKeyOf(spec.dedupe_key);
      const had = key ? this.core.tasks.find((t) => t.projectId === projectId && t.dedupeKey === key) : undefined;
      if (had) {
        existing.push(had);
        at.push(had);
        continue;
      }
      const deps = (spec.depends_on ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d < i).map((d) => at[d]!.id);
      const role = spec.role ? (roleByKey(spec.role) ?? matchRole(spec.role)) : undefined;
      const kind = TASK_KINDS.includes(spec.kind as TaskKind) ? (spec.kind as TaskKind) : 'feature';
      const priority = (['low', 'normal', 'high', 'urgent'] as const).includes(spec.priority as TaskPriority) ? (spec.priority as TaskPriority) : 'normal';
      const task = this.createTask({ projectId, title: spec.title.trim(), description: spec.description ?? '', acceptance: spec.acceptance ?? '', kind, priority, roleHint: role?.key ?? null, dependsOn: deps, released: auto && !key, dedupeKey: key }, `employee:${by.name}`);
      created.push(task);
      at.push(task);
    }
    const released = !created.some((t) => !t.released);
    if (rationale?.trim() && created.length) {
      this.eng.addArtifact({ kind: 'plan', title: `Plan by ${by.name} (${origin})`, content: `${rationale.trim()}\n\n${created.map((t) => `- **${t.key}** ${t.title}${t.roleHint ? ` _(${t.roleHint})_` : ''}${t.dependsOn.length ? ` — after ${t.dependsOn.map((d) => this.core.tasks.get(d)?.key).join(', ')}` : ''}`).join('\n')}`, projectId, employeeId: by.id });
    }
    if (!released) {
      const waiting = created.filter((t) => !t.released);
      this.eng.comms.notify({ kind: 'info', severity: 'warning', title: `${by.name} proposed ${waiting.length} tasks`, body: `They are in the backlog of ${project.name} until you release them.`, projectId, employeeId: by.id });
    }
    return { created, existing };
  }

  /** Ask a planner (typically the architect) to break an objective into tasks. */
  planProject(projectId: string, objective: string, plannerId: string, actor = 'owner'): Task {
    const project = this.core.projects.require(projectId);
    const planner = this.core.employees.require(plannerId);
    if (objective.trim() && !project.goals.includes(objective.trim())) {
      project.goals = `${project.goals}\n${objective.trim()}`.trim();
      this.core.put('project', project);
    }
    return this.createTask(
      {
        projectId,
        title: `Plan: ${truncate(objective, 70)}`,
        description: [
          `Objective from the boss: ${objective}`,
          '',
          'Produce the work breakdown for this objective:',
          '1. Call get_project_context and read the requirements. Inspect the repository to see what already exists.',
          '2. Call get_team to see which roles are on the team.',
          '3. Split the work into small tasks that can each be verified independently. Give every task a clear description, acceptance criteria, the role that should do it, and its dependencies. Include testing and security review tasks where they apply.',
          '4. Call propose_tasks with the full list (dependency order) and a short rationale.',
          '5. Call complete_task with no_code_changes=true.',
          'Do not implement anything yourself.',
        ].join('\n'),
        kind: 'planning',
        priority: 'high',
        assigneeId: planner.id,
        requiresReview: false,
        released: true,
      },
      actor,
    );
  }

  // ───────────────────────── progression ───────────────────────────

  awardXp(entry: XpEntry): void {
    if (!this.core.settings.gamification) return;
    const employee = this.core.employees.get(entry.employeeId);
    if (!employee) return;
    this.core.xp.put(entry);
    const { levelUp, newBadges } = applyXp(employee, entry);
    this.core.put('employee', employee);
    this.core.event({ type: 'progression.xp_awarded', source: 'server', summary: `${employee.name} earned ${entry.amount} XP — ${entry.note}`, employeeId: employee.id, data: { amount: entry.amount, reason: entry.reason, evidenceRef: entry.evidenceRef, quiet: true } });
    if (levelUp) {
      this.core.event({ type: 'progression.level_up', source: 'server', summary: `${employee.name} reached level ${levelUp}`, employeeId: employee.id, data: { level: levelUp, badges: newBadges } });
    }
  }

  checkMilestones(): void {
    if (!this.core.settings.gamification) return;
    const unlocked = evaluateMilestones(this.core.milestones, this.core.company);
    if (!unlocked.length) return;
    this.core.saveMilestones();
    for (const m of unlocked) {
      this.core.event({ type: 'progression.milestone', source: 'server', summary: `Company milestone: ${m.title}`, data: { key: m.key, unlocks: m.unlocks } });
      this.eng.comms.notify({ kind: 'milestone', severity: 'success', title: `Milestone: ${m.title}`, body: `${m.description}${m.unlocks ? ` Unlocked: ${m.unlocks.replace(/_/g, ' ')}.` : ''}` });
    }
  }

  // ───────────────────────────── views ─────────────────────────────

  /** Live git state of a task's (or an employee's) working tree, read from the host. */
  async gitView(ref: { taskId?: string; employeeId?: string }): Promise<{ cwd: string; status: unknown; diff: unknown; base: string | null }> {
    const task = ref.taskId ? this.core.tasks.require(ref.taskId) : this.currentTask(ref.employeeId);
    const employee = this.core.employees.get(task?.assigneeId ?? ref.employeeId);
    const session = employee ? this.core.sessionOf(employee.id) : undefined;
    const cwd = task?.worktree ?? session?.cwd;
    const hostId = session?.hostId ?? employee?.hostId;
    if (!cwd || !hostId) throw new EngineError('no working directory is known for this yet');
    if (!this.core.agents.isOnline(hostId)) throw new EngineError('the host is offline');
    const project = task ? this.core.projects.get(task.projectId) : this.core.projects.get(employee?.projectId);
    const base = task?.baseSha ?? (project?.repoPath ? project.integrationBranch : null);
    const [status, diff] = await Promise.all([
      this.core.agents.rpc(hostId, { method: 'git.status', params: { cwd } }),
      this.core.agents.rpc(hostId, { method: 'git.diff', params: { cwd, base, maxBytes: 300_000 } }),
    ]);
    return { cwd, status, diff, base };
  }
}
