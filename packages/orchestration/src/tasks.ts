import path from 'node:path';
import type { DeliveryState, Employee, Message, Project, ProjectPolicy, ReviewBy, Task, TaskKind, TaskPriority, TaskStatus, XpEntry } from '@orchestrator/contracts';
import { GATHER_SEC_MAX, REVIEW_BY, REVIEW_SEND_BACKS, matchRole, newId, nowIso, redactSecrets, reviewByOf, reviewDefaultOf, reviewUsualOf, roleByKey, slugify, truncate, stripEnd, LEAD_ROLE, directsOthers } from '@orchestrator/contracts';
import { applyXp, evaluateMilestones, xpForCompletedTask, xpForReview } from '@orchestrator/game-systems';
import { EngineError, within } from './core.ts';
import type { Engine } from './engine.ts';
import { reviewPrompt, taskPrompt, testedByOffice } from './prompts.ts';
import { SYNTAX_LABEL, syntaxChecked, syntaxCheckScript } from './syntax-check.ts';
import type { Person } from './task-talk.ts';
import { routingPreference } from './learning/detect.ts';

const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const PROJECT_COLORS = ['#4f8cff', '#ff8c5a', '#5ad67d', '#c58cff', '#f5c542', '#ff5d73', '#3fd0c9', '#ff9ecb'];
/** Task kinds that produce documents or verdicts rather than commits. */
const NON_CODE_KINDS = new Set<TaskKind>(['review', 'research', 'planning']);

const GENERIC = new Set(['engineer', 'developer', 'senior', 'junior', 'full', 'stack', 'fullstack', 'full-stack', 'backend', 'frontend', 'project', 'manager', 'team', 'work', 'task', 'with', 'from', 'that', 'this', 'the', 'and', 'for', 'code', 'server', 'admin', 'test', 'tests', 'docs', 'home', 'users', 'projects', 'src', 'app', 'apps', 'office', 'claude']);
const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERIC.has(w));

/**
 * How much a task's own words point at one employee: 0 … 3. Counted from distinctive words shared between the task's
 * title (and the start of its description) and the employee's name, title, speciality, skills and folder. Only ever
 * a tie-breaker between people who suit the task anyway.
 */
export function about(task: Pick<Task, 'title' | 'description'>, e: Pick<Employee, 'name' | 'title' | 'specialization' | 'skills' | 'workingDir'>): number {
  const theirs = new Set(words([e.name, e.title, e.specialization ?? '', ...(e.skills ?? []), path.basename(e.workingDir ?? '')].join(' ')));
  if (!theirs.size) return 0;
  const inTitle = new Set(words(task.title));
  const inText = new Set(words(String(task.description ?? '').slice(0, 400)));
  let score = 0;
  for (const w of theirs) score += inTitle.has(w) ? 1.5 : inText.has(w) ? 0.5 : 0;
  return Math.min(3, score);
}

/** What everyone in a shared folder is told. */
export const SHARED_FOLDER_RULES = 'You share this folder: stage only the files you changed yourself, by path (never `git add -A`, `git add .` or `git commit -a`); do not change, revert, stash or delete files you did not touch; if git says another git process is running (index.lock), wait a few seconds and try again.';
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
  /** Who reviews it (`docs/TASKS.md`). Without one — and without `requiresReview: false` — the office's default. */
  reviewBy?: ReviewBy;
  reviewerId?: string | null;
  reviewOf?: string | null;
  verifyCommand?: string | null;
  released?: boolean;
  dedupeKey?: string | null;
  /** The task this one is a part of. */
  parentId?: string | null;
  /** Colleagues put on the task with its assignee. */
  helperIds?: string[];
  /** A person of the office it is for, instead of an employee (`Task.personId`). */
  personId?: string | null;
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
  /** The colleague it is for, by name. Without one it goes to whoever suits it and is free. */
  assignee?: string;
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
/**
 * Are the fields of a change the kinds of thing they must be? `text`: a string that is not empty; `string?`: a string
 * or nothing; `list`: an array. A field that is absent is not looked at. Throws with the field's name.
 */
export function shaped(patch: Record<string, unknown>, shape: Record<string, 'text' | 'string' | 'string?' | 'number' | 'boolean' | 'list'>): void {
  for (const [field, kind] of Object.entries(shape)) {
    const v = patch?.[field];
    if (v === undefined) continue;
    const ok =
      kind === 'text' ? typeof v === 'string' && v.trim().length > 0 && v.length <= 2000
      : kind === 'string' ? typeof v === 'string' && v.length <= 200_000
      : kind === 'string?' ? v === null || (typeof v === 'string' && v.length <= 20_000)
      : kind === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : kind === 'boolean' ? typeof v === 'boolean'
      : Array.isArray(v) && v.length <= 500;
    if (!ok) throw new EngineError(`"${field}" is not ${kind === 'text' ? 'a text' : kind === 'list' ? 'a list' : kind === 'string?' ? 'a text (or nothing)' : `a ${kind}`}, or is too long`);
  }
}

/**
 * A project's permission policy: lists of short texts, and patterns that are patterns. (The high-risk patterns are run
 * as written against every command of the project's employees — who may set them is `access.ts`'s business; here
 * only that they can be run at all and are not a text of any size.)
 */
export function policyShaped(policy: Partial<ProjectPolicy> | undefined): void {
  if (policy === undefined) return;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new EngineError('"policy" is not a set of rules');
  for (const key of ['allow', 'deny', 'highRiskPatterns'] as const) {
    const list = policy[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 100 || list.some((x) => typeof x !== 'string' || !x || x.length > 300)) throw new EngineError(`"policy.${key}" is a list of at most 100 texts of at most 300 characters`);
  }
  // (null: the project follows the office again.)
  if (policy.review !== undefined && policy.review !== null && !REVIEW_BY.includes(policy.review)) throw new EngineError(`"policy.review" is one of ${REVIEW_BY.join(', ')}, or empty for the office's own way`);
  if (policy.gatherSec !== undefined && policy.gatherSec !== null && !(Number.isInteger(policy.gatherSec) && policy.gatherSec >= 0 && policy.gatherSec <= GATHER_SEC_MAX)) throw new EngineError(`"policy.gatherSec" is a whole number of seconds from 0 to ${GATHER_SEC_MAX}`);
  for (const pattern of policy.highRiskPatterns ?? []) {
    try {
      new RegExp(pattern, 'i');
    } catch {
      throw new EngineError(`"${truncate(pattern, 80)}" is not a pattern that can be run (a regular expression)`);
    }
  }
}

/** How the reason of a task begins that is approved and waits only for its merge (its machine was away). */
const WAITS_FOR_MERGE = 'Waiting to be merged into';

export class TaskManager {
  private eng: Engine;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private startingEmployees = new Set<string>();
  /**
   * Tasks that were stopped or removed since their hand-over began. A hand-over waits several times (for the session
   * to start, for files to be copied, for the memory to answer); when it wakes it must not go on with a task that
   * somebody took back meanwhile.
   */
  private takenBack = new Set<string>();
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
    shaped(input as unknown as Record<string, unknown>, { name: 'text', description: 'string', goals: 'string', requirements: 'string', docs: 'string', verifyCommand: 'string?', baseBranch: 'string?', repoPath: 'string?' });
    within(input as unknown as Record<string, unknown>, { name: 120, repoPath: 1024, baseBranch: 200, extraRepos: 20, dependsOn: 100 });
    policyShaped(input.policy);
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
    // What is stored is what every window renders: a field of the wrong kind (a name that is an object) would be
    // kept, and blank every window that shows it, at every reload.
    shaped(patch as Record<string, unknown>, { name: 'text', description: 'string', goals: 'string', requirements: 'string', docs: 'string', verifyCommand: 'string?', verifyTimeoutSec: 'number', color: 'string?', baseBranch: 'text', status: 'text', milestones: 'list', workspace: 'text', ownerEmployeeId: 'string?' });
    for (const key of ['name', 'description', 'goals', 'requirements', 'docs', 'verifyCommand', 'verifyTimeoutSec', 'color', 'baseBranch', 'status', 'milestones', 'workspace', 'ownerEmployeeId'] as const) {
      if (patch[key] !== undefined) (p as any)[key] = patch[key];
    }
    within(patch as Record<string, unknown>, { name: 120, baseBranch: 200, extraRepos: 20, dependsOn: 100 });
    policyShaped(patch.policy);
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
      const p = stripEnd(String(r?.path ?? '').trim(), '/');
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

  /**
   * May this employee be given this task at all? Not across the line between the shared office and a member's own
   * computer (whoever asks: the task's text, its files and its project would go with it), and never the foreman,
   * who supervises and does not take tasks — a review is the one kind of task that is not "work" in that sense,
   * and it is not given to the foreman either.
   */
  mayTake(e: Employee, task: Pick<Task, 'projectId' | 'key'> & { kind?: string }): void {
    if (e.roleKey === 'foreman') throw new EngineError(`${e.name} is the foreman and does not take tasks.`);
    if (e.roleKey === LEAD_ROLE) throw new EngineError(`${e.name} is a team lead and does not take tasks: tell them what you want, and they hand it to the right one.`);
    if (!this.canSee(e, task as Task)) throw new EngineError(`${e.name} cannot take ${task.key}: work does not cross between the shared office and a member's own computer.`);
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
    shaped(input as unknown as Record<string, unknown>, { title: 'text', description: 'string', acceptance: 'string', roleHint: 'string?', dependsOn: 'list', verifyCommand: 'string?', personId: 'string?' });
    const project = this.core.projects.require(input.projectId);
    const title = input.title?.trim();
    if (!title) throw new EngineError('a task needs a title');
    if (input.assigneeId && input.personId) throw new EngineError('a task is for an employee or for a person, not both');
    const person = input.personId ? this.personOf(input.personId) : null;
    if (input.assigneeId) this.mayTake(this.core.employees.require(input.assigneeId), { projectId: project.id, key: 'this task', kind: input.kind ?? 'feature' });
    for (const dep of input.dependsOn ?? []) if (!this.core.tasks.get(dep)) throw new EngineError(`unknown dependency ${dep}`);
    const kind = input.kind && TASK_KINDS.includes(input.kind) ? input.kind : 'feature';
    const parent = input.parentId ? this.core.tasks.get(input.parentId) : undefined;
    if (input.parentId && (!parent || parent.projectId !== project.id || parent.parentId)) throw new EngineError('a part belongs to a task of the same project that is not itself a part');
    const reviewBy = this.reviewFor(input, kind, project, !!parent);
    const now = nowIso();
    // Credentials written into a task are kept in the vault; the task carries their names.
    const author = by === 'owner' ? { kind: 'owner' as const, id: null, name: 'The boss' } : { kind: by.startsWith('employee:') ? ('employee' as const) : ('member' as const), id: null, name: by.replace(/^[a-z]+:/, '') };
    input = { ...input, description: this.eng.vault.capture(input.description ?? '', author, [project.name]).text, acceptance: this.eng.vault.capture(input.acceptance ?? '', author, [project.name]).text };
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
      requiresReview: reviewBy !== 'none',
      reviewBy,
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
      ...(parent ? { parentId: parent.id } : {}),
      ...(person ? { personId: person.id, personName: person.name } : {}),
    };
    if (input.helperIds?.length && !person) this.eng.talk.setHelpers(task, input.helperIds, by);
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
    if (person) {
      this.history(task, `Assigned to ${person.name} (a person)`, by);
      this.tellPerson(task, person, by);
      this.core.put('task', task);
    }
    this.schedule();
    return task;
  }

  /** What the office reviews by when it reviews at all: its default, or — where that is "nobody" — a colleague. */
  /** How a task that must be reviewed is reviewed, when nobody said by whom: its project's way, else the office's. */
  private usualReview(project?: Project | null): ReviewBy {
    const usual = reviewUsualOf(this.core.settings, project);
    return usual === 'none' ? 'peer' : usual;
  }

  /**
   * Who reviews a new task. Chosen for it: that. Otherwise every task is reviewed the way its project is (where an
   * owner set one for it: `ProjectPolicy.review`), else the way the office reviews (a colleague, then the boss,
   * unless the owner set it differently) — a review itself and a part of a task are not.
   * Only in an office whose owner set "nobody" is it as it was before: a project's own "require review", for work
   * that makes commits.
   */
  private reviewFor(input: Pick<TaskInput, 'reviewBy' | 'requiresReview' | 'reviewOf'>, kind: TaskKind, project: Project, part: boolean): ReviewBy {
    if (kind === 'review' || input.reviewOf) return 'none';
    if (input.reviewBy && REVIEW_BY.includes(input.reviewBy)) return input.reviewBy;
    if (input.requiresReview === false) return 'none';
    if (input.requiresReview === true) return this.usualReview(project);
    if (part) return 'none';
    const usual = reviewUsualOf(this.core.settings, project);
    if (usual !== 'none') return usual;
    // ("No review" chosen for this project is that; the older "require review" is for a project that follows an
    // office set to nobody.)
    if (project.policy.review === 'none') return 'none';
    return project.policy.requireReview && !NON_CODE_KINDS.has(kind) ? 'peer' : 'none';
  }

  /** A line in a task's record. */
  note(task: Task, note: string, by: string): void {
    this.history(task, note, by);
  }

  private emitAssigned(task: Task, by: string): void {
    const emp = this.core.employees.get(task.assigneeId);
    if (!emp) return;
    this.core.event({ type: 'task.assigned', source: by === 'owner' ? 'owner' : 'server', summary: `${task.key} assigned to ${emp.name}`, taskId: task.id, projectId: task.projectId, employeeId: emp.id, data: { key: task.key, by } });
  }

  updateTask(id: string, patch: Partial<TaskInput> & { status?: TaskStatus }, actor = 'owner'): Task {
    const task = this.core.tasks.require(id);
    // Before anything is changed: a change that is refused changes nothing.
    shaped(patch as Record<string, unknown>, { title: 'text', description: 'string', acceptance: 'string', kind: 'text', priority: 'text', roleHint: 'string?', dependsOn: 'list', requiresReview: 'boolean', reviewBy: 'text', reviewerId: 'string?', verifyCommand: 'string?', released: 'boolean', assigneeId: 'string?', personId: 'string?', status: 'text', helperIds: 'list' });
    if (patch.reviewBy !== undefined && !REVIEW_BY.includes(patch.reviewBy)) throw new EngineError(`reviewBy is one of ${REVIEW_BY.join(', ')}`);
    if (patch.personId !== undefined && (patch.personId ?? null) !== (task.personId ?? null)) {
      if (task.status === 'IN_PROGRESS' && !task.personId) throw new EngineError(`${task.key} is in progress; block or finish it before reassigning`);
      if (patch.personId) {
        const person = this.personOf(patch.personId);
        task.personId = person.id;
        task.personName = person.name;
        task.assigneeId = null;
        if (task.helperIds?.length) this.eng.talk.setHelpers(task, [], actor);
        this.history(task, `Assigned to ${person.name} (a person)`, actor);
        this.tellPerson(task, person, actor);
      } else {
        this.history(task, `No longer ${task.personName ?? 'a person'}'s`, actor);
        task.personId = null;
        task.personName = null;
      }
    }
    if (patch.assigneeId !== undefined && patch.assigneeId !== task.assigneeId) {
      if (task.status === 'IN_PROGRESS' && !task.personId) throw new EngineError(`${task.key} is in progress; block or finish it before reassigning`);
      // An employee now, not a person.
      if (patch.assigneeId && task.personId) {
        task.personId = null;
        task.personName = null;
        if (task.status === 'IN_PROGRESS') task.status = 'READY';
      }
      if (patch.assigneeId) this.mayTake(this.core.employees.require(patch.assigneeId), task);
      task.assigneeId = patch.assigneeId;
      this.history(task, patch.assigneeId ? `Assigned to ${this.core.employees.get(patch.assigneeId)?.name}` : 'Unassigned', actor);
      if (patch.assigneeId) this.emitAssigned(task, actor);
    }
    // A credential typed into a task's text when it is edited goes to the vault like one typed when it was made.
    const editor = actor === 'owner' ? { kind: 'owner' as const, id: null, name: 'The boss' } : { kind: actor.startsWith('employee:') ? ('employee' as const) : ('member' as const), id: null, name: actor.replace(/^[a-z]+:/, '') };
    const hints = [this.core.projects.get(task.projectId)?.name ?? ''];
    for (const key of ['description', 'acceptance'] as const) if (typeof patch[key] === 'string' && patch[key] !== task[key]) patch = { ...patch, [key]: this.eng.vault.capture(patch[key] as string, editor, hints).text };
    for (const key of ['title', 'description', 'acceptance', 'kind', 'priority', 'roleHint', 'dependsOn', 'requiresReview', 'reviewBy', 'reviewerId', 'verifyCommand', 'released'] as const) {
      if (patch[key] !== undefined) (task as any)[key] = patch[key];
    }
    // Who reviews it, said either way: the two fields say the same thing.
    if (patch.reviewBy !== undefined) task.requiresReview = patch.reviewBy !== 'none';
    else if (patch.requiresReview !== undefined) task.reviewBy = patch.requiresReview ? (task.reviewBy && task.reviewBy !== 'none' ? task.reviewBy : this.usualReview(this.core.projects.get(task.projectId))) : 'none';
    if (patch.helperIds !== undefined) this.eng.talk.setHelpers(task, patch.helperIds, actor);
    if (patch.status && patch.status !== task.status) this.moveByOwner(task, patch.status, actor);
    task.updatedAt = nowIso();
    this.core.put('task', task);
    this.core.event({ type: 'task.updated', source: 'owner', summary: `${task.key} was updated`, taskId: id, projectId: task.projectId, employeeId: task.assigneeId, data: { fields: Object.keys(patch), quiet: true } });
    this.schedule();
    return task;
  }

  /**
   * Closed without being done (`cancel_task`, the owner's wish of 2026-11-20 that employees can cancel a task): DONE,
   * with who and why on it, its deliveries taken back, the boss told. Nothing is deleted; moved back on the board it
   * is not cancelled any more (`moveByOwner`). `by`: who, in words.
   */
  cancel(id: string, reason: string, actor: string, by: string): Task {
    const task = this.core.tasks.require(id);
    if (task.status === 'DONE') throw new EngineError(`${task.key} is already closed (DONE).`);
    this.eng.comms.cancelFor({ kind: 'task', id: task.id });
    task.status = 'DONE';
    task.cancelled = { at: nowIso(), by, reason };
    task.completedAt = nowIso();
    task.blockedReason = null;
    task.waitingFor = null;
    task.reviewStage = null;
    task.delivery = { status: 'none', via: null, ts: null, detail: null };
    task.updatedAt = nowIso();
    this.history(task, `Cancelled by ${by}: ${reason}`, actor);
    this.core.put('task', task);
    if (task.parentId) this.eng.talk.partSettled(task, 'removed');
    this.core.audit(actor, 'task.cancelled', task.id, { key: task.key, reason });
    this.core.event({ type: 'task.cancelled', source: actor.startsWith('employee:') ? 'mcp' : 'owner', summary: `${by} cancelled ${task.key} "${truncate(task.title, 80)}": ${truncate(reason, 160)}`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, reason, by } });
    this.eng.comms.notify({ kind: 'info', severity: 'info', title: `${by} cancelled ${task.key}: ${truncate(task.title, 80)}`, body: `${reason}\n\nIt is closed, not deleted. Move it back on the board to reopen it.`, taskId: task.id, projectId: task.projectId });
    this.schedule();
    return task;
  }

  /** A person of the office a task may be for: an owner or a colleague who is still here (`Comms.people`). */
  private personOf(id: string): { id: string; name: string; owner: boolean } {
    const person = this.eng.comms.people().find((p) => p.id === id);
    if (!person) throw new EngineError('that person is not in the office (an owner or a colleague who is still here)');
    return person;
  }

  /** Told in their Inbox, and only theirs: a task is theirs now. */
  private tellPerson(task: Task, person: { id: string; name: string }, actor: string): void {
    const project = this.core.projects.get(task.projectId);
    const by = actor === 'owner' ? (this.core.settings.ownerName || 'The boss') : actor.replace(/^[a-z]+:/, '');
    this.eng.comms.notify({
      kind: 'task_assigned',
      severity: 'info',
      title: `A new task for you: ${task.key} ${task.title}`,
      body: `${by === person.name ? 'You' : by} assigned ${task.key} to you${project ? ` (${project.name})` : ''}.${task.description.trim() ? `\n\n${task.description.trim().slice(0, 600)}` : ''}`,
      taskId: task.id,
      projectId: task.projectId,
      for: [person.id],
    });
    this.core.event({ type: 'task.assigned', source: 'owner', summary: `${task.key} was assigned to ${person.name}`, taskId: task.id, projectId: task.projectId, data: { key: task.key, person: person.id } });
  }

  /** Manual board moves by the owner. DONE is never set by hand without saying so in the record. */
  private moveByOwner(task: Task, status: TaskStatus, actor: string): void {
    const from = task.status;
    // A person's task is moved on by the person: "I am on it" is theirs to say. An employee's starts when it is delivered.
    if (status === 'IN_PROGRESS' && !task.personId) throw new EngineError('tasks start when they are delivered to an employee; move the task to READY and assign it');
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
    else {
      task.blockedReason = null;
      task.waitingFor = null;
    }
    if (status !== 'REVIEW') task.reviewStage = null;
    // Moved back by hand: it is wanted again.
    if (status !== 'DONE' && task.cancelled) {
      task.cancelled = null;
      task.completedAt = null;
    }
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

  /** A real Escape in the real terminal of whoever is working on this task, if they are in a turn. Returns whether one was sent. */
  private async interruptFor(task: Task, why: string): Promise<boolean> {
    const session = this.core.runningSessionOf(task.assigneeId);
    if (!session || !this.core.agents.isOnline(session.hostId)) return false;
    if (session.inTurn === false) return false;
    await this.core.agents.rpc(session.hostId, { method: 'session.interrupt', params: { sessionId: session.id } }).catch(() => undefined);
    if (session.capabilities.hooks) session.inTurn = false;
    this.eng.sessions.setActivity(session, 'idle', why);
    this.core.event({ type: 'terminal.interrupt', source: 'owner', summary: `${this.core.employees.get(task.assigneeId)?.name ?? 'Employee'} was interrupted: ${why}`, sessionId: session.id, employeeId: task.assigneeId, hostId: session.hostId, taskId: task.id, data: { via: 'terminal' } });
    return true;
  }

  /**
   * Stop a task somebody is working on. Their turn is interrupted in the real terminal, they are told to leave it,
   * and the task is put on hold (kept, with its branch and its assignee, until it is released again) or deleted.
   * A task nobody has in hand is simply put on hold or deleted.
   */
  async stopTask(id: string, opts: { then?: 'hold' | 'delete'; note?: string | null } = {}, actor = 'owner'): Promise<{ key: string; interrupted: boolean; deleted: boolean }> {
    const task = this.core.tasks.require(id);
    const then = opts.then === 'delete' ? 'delete' : 'hold';
    if (task.status === 'DONE') throw new EngineError(`${task.key} is done; there is nothing to stop`);
    if (this.verifying.has(task.id)) throw new EngineError(`${task.key} is being verified right now; stop it when that has finished`, 409);
    const note = truncate(String(opts.note ?? '').trim(), 2000);
    const employee = this.core.employees.get(task.assigneeId);
    const wasInProgress = task.status === 'IN_PROGRESS';
    const who = actor === 'owner' ? 'the boss' : actor.replace(/^[a-z]+:/, '');
    // A hand-over of this task that is still on its way ends here.
    this.takenBack.add(task.id);
    // The board first: whatever the session says while it is being stopped no longer concerns this task.
    this.eng.comms.cancelFor({ kind: 'task', id: task.id });
    for (const q of this.core.questions.filter((x) => x.taskId === task.id && x.status === 'open' && x.channel !== 'system')) this.eng.comms.supersede(q.id, `${task.key} was stopped.`);
    task.status = 'BACKLOG';
    task.released = false;
    task.blockedReason = null;
    task.nudges = 0;
    task.delivery = { status: 'none', via: null, ts: null, detail: null };
    task.progress = { percent: null, note: null, ts: null };
    this.history(task, `Stopped by ${who}${note ? `: ${note}` : ''} — ${then === 'delete' ? 'and removed' : 'on hold until it is released again'}`, actor);
    task.updatedAt = nowIso();
    this.core.put('task', task);
    let interrupted = false;
    let wip: string | null = null;
    // Nothing new is handed to them until their folder has been dealt with. (If something is already being handed
    // to them, that hand-over holds the place and gives it back itself.)
    const held = !!employee && !this.startingEmployees.has(employee.id);
    if (held) this.startingEmployees.add(employee!.id);
    try {
    if (wasInProgress && employee) {
      const running = this.core.runningSessionOf(employee.id);
      // Somebody whose machine is away for a moment is still there, with this task in their head: they are told
      // when it is back.
      const live = running ?? this.core.sessions.find((x) => x.employeeId === employee.id && (x.status === 'starting' || x.status === 'host_offline'));
      interrupted = await this.interruptFor(task, `${task.key} was stopped`);
      // In a worktree of their own, what they had half-done is put away on the task's branch: the folder is clean for
      // the next task (a branch is never switched over uncommitted files), and it is all there if this one is taken
      // up again. In a folder worked in place nothing is touched: uncommitted files there are never the office's.
      const project = this.core.projects.get(task.projectId);
      const hostId = running?.hostId ?? employee.hostId;
      if (project && project.workspace !== 'in_place' && task.worktree && task.branch && /^orch\//.test(task.branch) && hostId && this.core.agents.isOnline(hostId)) {
        if (interrupted) await new Promise((r) => setTimeout(r, 400));
        try {
          const res = await this.core.agents.rpc<{ committed: boolean; sha: string | null; files: number }>(hostId, { method: 'git.wip', params: { cwd: task.worktree, branch: task.branch, message: `WIP ${task.key}: stopped by ${who} — work in progress, not finished` } }, 20000);
          if (res.committed) {
            wip = res.sha;
            this.history(task, `What was uncommitted (${res.files} file${res.files === 1 ? '' : 's'}) was committed on ${task.branch} as work in progress (${String(res.sha).slice(0, 7)})`, 'orchestrator');
            this.core.put('task', task);
          }
        } catch (e) {
          // An older agent on that machine, or the folder is not on the task's branch: the employee is asked to do it.
          this.core.log('info', `stopping ${task.key}: work in progress was not committed by the office (${(e as Error).message})`);
          wip = 'ask';
        }
      }
      if (live) {
        const left = wip === 'ask' ? `Before anything else, make your folder clean: commit what you have${task.branch ? ` on ${task.branch}` : ''} as work in progress (or discard it if it is worth nothing) — your next task cannot start over uncommitted files.` : wip ? `What you had uncommitted was committed on ${task.branch} as work in progress; your folder is clean.` : `Leave what you have as it is${task.branch ? ` (what you committed stays on ${task.branch})` : ''}.`;
        this.eng.comms.sendMessage({
          from: { kind: 'owner', id: null, name: who },
          toEmployeeId: employee.id,
          kind: 'system',
          body: `${who === 'the boss' ? 'The boss' : who} stopped ${task.key} "${truncate(task.title, 100)}". Stop working on it now: do not continue it and do not call complete_task for it.${note ? `\n\nWhy: ${note}` : ''}\n\n${left} ${then === 'delete' ? 'The task was removed from the board.' : 'It is on hold; if it is released again it comes back to you.'} You are free for other work.`,
        });
        this.eng.comms.schedulePump(employee.id, 300);
      }
    }
    } finally {
      if (held) this.startingEmployees.delete(employee!.id);
    }
    this.core.audit(actor, 'task.stopped', task.id, { key: task.key, then, interrupted, note: note || undefined });
    this.core.event({ type: 'task.stopped', source: 'owner', summary: `${task.key} was stopped by ${who}${employee && wasInProgress ? ` (${employee.name} was working on it)` : ''} — ${then === 'delete' ? 'removed' : 'on hold'}`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, then, interrupted, note: note || null } });
    if (then === 'delete') this.deleteTask(task.id, actor);
    this.schedule();
    return { key: task.key, interrupted, deleted: then === 'delete' };
  }

  /**
   * Correct a task: change what it says and/or say what should be done differently. Whoever is working on it is told
   * at once — interrupted first when `now` is set, otherwise as soon as their turn ends — and goes on with the task.
   */
  async correctTask(id: string, input: { note?: string | null; title?: string; description?: string; acceptance?: string; now?: boolean }, actor = 'owner'): Promise<Task & { told: boolean }> {
    const task = this.core.tasks.require(id);
    if (task.status === 'DONE') throw new EngineError(`${task.key} is done; make a new task for what should change`);
    const note = truncate(String(input.note ?? '').trim(), 4000);
    const changed: string[] = [];
    const who = actor === 'owner' ? 'the boss' : actor.replace(/^[a-z]+:/, '');
    for (const key of ['title', 'description', 'acceptance'] as const) {
      const v = input[key];
      if (typeof v === 'string' && v.trim() !== task[key].trim() && (key !== 'title' || v.trim())) {
        // (A credential in the corrected text goes to the vault; the task names it.)
        task[key] = key === 'title' ? v.trim() : this.eng.vault.capture(v.trim(), { kind: 'owner', id: null, name: who }, [this.core.projects.get(task.projectId)?.name ?? '']).text;
        changed.push(key);
      }
    }
    if (!note && !changed.length) throw new EngineError('say what should change, or change the task\'s text');
    // A correction that carries a credential: the credential goes to the vault, the task names it.
    const kept = note ? this.eng.vault.capture(note, { kind: 'owner', id: null, name: who }, [this.core.employees.get(task.assigneeId)?.name ?? '']).text : '';
    this.history(task, `Corrected by ${who}${kept ? `: ${truncate(kept, 300)}` : ''}${changed.length ? ` (changed: ${changed.join(', ')})` : ''}`, actor);
    task.nudges = 0;
    task.updatedAt = nowIso();
    this.core.put('task', task);
    const employee = this.core.employees.get(task.assigneeId);
    // (Running, or on a machine that is away for a moment: the message waits for them.)
    const running = employee ? (this.core.runningSessionOf(employee.id) ?? this.core.sessions.find((x) => x.employeeId === employee.id && (x.status === 'starting' || x.status === 'host_offline'))) : undefined;
    let told = false;
    if (task.status === 'IN_PROGRESS' && employee && running) {
      const now = changed.length
        ? `\n\nThe task now reads:\n${task.title}${task.description.trim() ? `\n\n${task.description.trim()}` : ''}${task.acceptance.trim() ? `\n\nAcceptance criteria:\n${task.acceptance.trim()}` : ''}`
        : '';
      this.eng.comms.sendMessage({
        from: { kind: 'owner', id: null, name: who },
        toEmployeeId: employee.id,
        kind: 'chat',
        taskId: task.id,
        body: `Correction to ${task.key} "${truncate(task.title, 100)}" from ${who}${kept ? `:\n${kept}` : '.'}${now}\n\nGo on with ${task.key} with this in mind. Where what you have done so far goes against it, change it; then finish as usual (complete_task).`,
      });
      told = true;
      if (input.now) {
        await this.interruptFor(task, `${task.key} was corrected`);
        this.eng.comms.schedulePump(employee.id, 300);
      }
    }
    // Nobody to tell: a note that only stood in the task's history would never be read (the hand-over does not carry
    // the history). It is written into the task itself, so whoever gets the task next gets it too.
    if (!told && kept) {
      task.description = `${task.description.trim()}${task.description.trim() ? '\n\n' : ''}Correction from ${who} (${nowIso().slice(0, 10)}): ${kept}`;
      this.core.put('task', task);
    }
    this.core.audit(actor, 'task.corrected', task.id, { key: task.key, changed, told, now: !!input.now });
    this.core.event({ type: 'task.corrected', source: 'owner', summary: `${task.key} was corrected by ${who}${told ? ` — ${employee!.name} was told${input.now ? ' at once' : ''}` : ''}`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, changed, told, now: !!input.now, note: truncate(kept, 600) || null } });
    this.schedule();
    return { ...task, told };
  }

  deleteTask(id: string, actor = 'owner'): void {
    const task = this.core.tasks.require(id);
    if (task.status === 'IN_PROGRESS') throw new EngineError('cannot delete a task that is in progress');
    this.takenBack.add(id);
    for (const t of this.core.tasks.filter((x) => x.dependsOn.includes(id))) {
      t.dependsOn = t.dependsOn.filter((d) => d !== id);
      this.core.put('task', t);
    }
    // Its parts stand on their own from now on; and if it was a part, the task it belonged to no longer waits for it.
    for (const t of this.core.tasks.filter((x) => x.parentId === id)) {
      t.parentId = null;
      this.core.put('task', t);
    }
    this.core.remove('task', id);
    if (task.parentId) this.eng.talk.partSettled(task, 'removed');
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
  /**
   * What this employee has asked about a task and not been answered yet: a task of theirs parked on a question, or
   * a question of theirs to the boss about a task (whatever became of that task since — handed in, in review) that
   * is still open. While there is one they are given nothing new — whoever asked waits for the answer, and does not
   * start the next thing with the first one hanging (the owner's rule of 2026-11-12, after an employee parked a
   * task on a question and was handed, and finished, another one before it was answered). A question that is about
   * no task — asked in a talk with the boss, in a routine — is not work that is hanging, and holds nothing.
   */
  awaitingAnswer(employeeId: string): { task?: Task; question?: string } | null {
    const task = this.core.tasks.find((t) => t.assigneeId === employeeId && t.status === 'BLOCKED' && t.waitingFor?.kind === 'answer');
    if (task) return { task };
    const q = this.core.questions.find((x) => x.employeeId === employeeId && x.status === 'open' && x.channel === 'mcp_tool' && x.kind !== 'permission' && !!x.taskId && !!this.core.tasks.get(x.taskId));
    return q ? { question: q.id } : null;
  }

  isFree(e: Employee): boolean {
    if (e.archived || !this.withinSchedule(e)) return false;
    if (this.startingEmployees.has(e.id) || this.currentTask(e.id)) return false;
    if (this.eng.moves.isMoving(e)) return false;
    if (this.awaitingAnswer(e.id)) return false;
    if (!e.hostId || !this.core.agents.isOnline(e.hostId)) return false;
    if (e.executionMode === 'codex_managed' && this.eng.sessions.cannotStart(e)) return false;
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
    const pool = this.core.employees.filter((e) => !e.selfDriven && !this.eng.rent.isWalled(e.id) && this.isFree(e) && sameComputer(e) && (e.projectId === task.projectId || e.projectId === null || !!e.alsoProjectIds?.includes(task.projectId)));
    let best: { e: Employee; score: number; reason: string | null } | undefined;
    for (const e of pool) {
      // A foreman supervises; work is never routed to one.
      if (directsOthers(e.roleKey)) continue;
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
      // In an office where everyone has the same trade, the task usually says whose it is: the part of the product in
      // a colleague's name, title, speciality or folder ("Marketplace: …" → the one who keeps the marketplace).
      score += about(task, e);
      // A preference the owner accepted from the record ("give this kind to X first") decides between suitable people.
      const preferred = routingPreference(this.core.settings, this.core.projects.get(task.projectId), task.kind, e.id);
      score += preferred.bonus;
      if (!best || score > best.score) best = { e, score, reason: preferred.reason ?? learned.reason };
    }
    this.lastRoutingReason = best?.reason ?? null;
    return best?.e;
  }

  private runSchedule(): void {
    this.closeStaleReviews();
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
        // A person's task: theirs to do, never handed to an employee.
        if (t.personId) continue;
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
    if (!project.hostId || project.hostId === employee.hostId) {
      // Someone whose own folder lies inside the project's folder (one of several repositories under one root, a
      // package of a monorepo) works there, not at the root — so colleagues in other subfolders are not in their way.
      const own = employee.workingDir ? path.resolve(employee.workingDir) : null;
      if (own && own !== path.resolve(project.repoPath) && own.startsWith(path.resolve(project.repoPath) + path.sep)) return own;
      return project.repoPath;
    }
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

  /** Other employees' code tasks in progress in the same folder, or in the same git repository, on the same machine. */
  private sharing(task: Task, employee: Employee, cwd: string): Task[] {
    const here = path.resolve(cwd);
    return this.core.tasks.filter((t) => {
      if (t.id === task.id || t.status !== 'IN_PROGRESS' || t.assigneeId === employee.id || !t.worktree || NON_CODE_KINDS.has(t.kind)) return false;
      if (this.core.employees.get(t.assigneeId)?.hostId !== employee.hostId) return false;
      return path.resolve(t.worktree) === here || (!!task.repoRoot && !!t.repoRoot && path.resolve(t.repoRoot) === path.resolve(task.repoRoot));
    });
  }

  /** A file this task's session wrote (from its hooks). Remembered so that, in a shared folder, its uncommitted work can be told from a colleague's. */
  noteTouched(task: Task, file: string): void {
    const root = task.repoRoot ?? task.worktree;
    if (!root || task.status !== 'IN_PROGRESS') return;
    const rel = path.relative(path.resolve(root), path.resolve(task.worktree ?? root, file));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || task.touched?.includes(rel)) return;
    task.touched = [...(task.touched ?? []), rel].slice(-2000);
    this.core.put('task', task);
  }

  /** A task whose folder somebody else is working in: say so once, on the task itself, and leave it ready. */
  private waitForFolder(task: Task, clash: Task, cwd: string): void {
    const other = this.core.employees.get(clash.assigneeId);
    const note = `Waiting for ${other?.name ?? 'a colleague'} to finish ${clash.key}: they work in the same folder (${cwd}), one at a time`;
    if (task.progress.note === note) return;
    task.progress = { percent: null, note, ts: nowIso() };
    this.history(task, note, 'scheduler');
    this.core.put('task', task);
    this.core.event({ type: 'task.updated', source: 'server', summary: `${task.key} waits its turn: ${other?.name ?? 'a colleague'} is working in the same folder (${clash.key})`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, waitingFor: clash.id, folder: cwd } });
  }

  /**
   * Finished work that waits for a review nobody was asked for — from before a colleague could review where the team
   * has no reviewer by trade: a colleague is asked now. Only where one can be found; what waits for the boss because
   * there is nobody else, goes on waiting for the boss.
   */
  rerouteReviews(): number {
    if (this.core.settings.employeesManageBoard === false) return 0;
    let n = 0;
    for (const t of this.core.tasks.filter((x) => x.status === 'REVIEW' && !x.reviewerId && !x.evidence.review && !x.evidence.peerReview && reviewByOf(x) !== 'boss' && !this.core.tasks.find((r) => r.reviewOf === x.id && r.status !== 'DONE'))) {
      if (!this.pickReviewer(t)) continue;
      this.history(t, 'No reviewer had been asked: a colleague is asked now', 'orchestrator');
      this.requestReview(t, null);
      this.eng.comms.resolveNotifications((x) => x.kind === 'review' && x.taskId === t.id);
      n++;
    }
    if (n) this.schedule();
    return n;
  }

  /**
   * Tasks that an earlier version blocked because somebody else was working in the same folder: back in the queue.
   * (They were never the employee's problem to solve, and nothing unblocked them by itself.)
   */
  requeueFolderWaits(): number {
    let n = 0;
    for (const t of this.core.tasks.filter((x) => x.status === 'BLOCKED' && /Two employees must not edit the same working tree/.test(x.blockedReason ?? ''))) {
      t.status = 'READY';
      t.released = true;
      t.blockedReason = null;
      this.history(t, 'Back in the queue: it waits for the folder to be free instead of being blocked', 'orchestrator');
      this.core.put('task', t);
      this.eng.comms.resolveNotifications((x) => x.kind === 'blocked' && x.taskId === t.id);
      n++;
    }
    if (n) this.schedule();
    return n;
  }

  /** Prepare an isolated workspace, make sure the employee's real session is up, and hand over the task. */
  async startTask(task: Task): Promise<void> {
    const employee = this.core.employees.require(task.assigneeId!);
    const project = this.core.projects.require(task.projectId);
    // (Asked once more where the work really begins: nothing is handed over across the line, however it got assigned.)
    if (!this.canSee(employee, task)) return void this.fail(task, `${employee.name} cannot take ${task.key}: work does not cross between the shared office and a member's own computer.`);
    this.takenBack.delete(task.id);
    /** Was the task stopped, removed or given to somebody else while this hand-over waited? */
    const takenBack = () => this.takenBack.has(task.id) || !this.core.tasks.get(task.id) || this.core.tasks.get(task.id)!.assigneeId !== employee.id || !this.core.employees.get(employee.id);
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
        // In their own subfolder they stay in it; at the project's folder, at the root of its repository as before.
        cwd = path.resolve(repo) !== path.resolve(project.repoPath!) ? insp.path : (insp.repoRoot ?? insp.path);
        task.repoRoot = insp.isGitRepo ? (insp.repoRoot ?? null) : null;
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
            // (Opened again after it was done: its new work starts on a fresh branch, from where the project stands now.)
            const name = task.branch ?? `orch/${slugify(employee.name)}/${task.key.toLowerCase()}${task.reopened ? `-r${task.reopened}` : ''}-${slugify(task.title, 28)}`;
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
      // Colleagues who are changing the same folder (or the same repository) right now.
      const sharing = codeTask ? this.sharing(task, employee, cwd) : [];
      if (sharing.length && project.policy.oneAtATime) {
        // This project asked for one at a time: the task waits its turn. It stays ready, no session is started for it,
        // and the scheduler hands it over when the folder is free.
        this.waitForFolder(task, sharing[0]!, cwd);
        return;
      }
      if (sharing.length) {
        // The default: they work side by side. Each is told about the other, and from now on a task counts only the
        // files its own session wrote as its uncommitted work.
        task.sharedWith = [...new Set([...(task.sharedWith ?? []), ...sharing.map((t) => this.core.employees.get(t.assigneeId)?.name ?? 'a colleague')])];
        for (const other of sharing) {
          const them = this.core.employees.get(other.assigneeId);
          if (other.sharedWith?.includes(employee.name)) continue;
          other.sharedWith = [...(other.sharedWith ?? []), employee.name];
          this.core.put('task', other);
          if (them) this.eng.comms.sendMessage({ from: { kind: 'system', id: null, name: 'the office' }, toEmployeeId: them.id, kind: 'system', taskId: other.id, body: `${employee.name} is starting ${task.key} "${truncate(task.title, 80)}" in the same folder you work in (${cwd}). Go on with ${other.key}. ${SHARED_FOLDER_RULES}` });
        }
      }
      await this.eng.sessions.start(employee.id, { cwd, actor: 'scheduler' });
      if (takenBack()) return;

      task.worktree = cwd;
      task.branch = branch;
      task.baseSha = baseSha;
      // An approval was for the work as it stood then. Back with its author — to resolve a conflict, after being
      // unblocked — what comes next is new work, and is reviewed as such.
      if (task.evidence.review?.verdict === 'approved') task.evidence.review = null;
      task.status = 'IN_PROGRESS';
      task.blockedReason = null;
      task.waitingFor = null;
      task.reviewStage = null;
      task.startedAt = task.startedAt ?? nowIso();
      task.nudges = 0;
      task.progress = { percent: null, note: null, ts: null };
      task.delivery = { status: 'queued', via: null, ts: nowIso(), detail: 'Waiting for the session to be ready for input' };
      this.history(task, `Handed to ${employee.name}`, 'scheduler');
      this.core.put('task', task);

      let text: string;
      if (task.kind === 'review' && task.reviewOf) {
        const target = this.core.tasks.require(task.reviewOf);
        text = reviewPrompt(task, target, project, this.core.employees.get(target.assigneeId)?.name ?? 'a teammate', employee.executionMode === 'codex_managed');
        // (First task on this project: what the team has learned, once, ahead of the lessons chosen for this task.)
        const playbook = [this.eng.improver.capture.onboardingBlock(employee, project), this.eng.improver.playbookBlock(employee, project.id, true, task)].filter(Boolean).join('\n\n');
        if (playbook) text += `\n\n${playbook}`;
      } else {
        const deps = task.dependsOn.map((id) => this.core.tasks.get(id)).filter((t): t is Task => !!t);
        const fb: string[] = [];
        if (task.evidence.review?.verdict === 'changes_requested') fb.push(`Review (${task.evidence.review.by === 'owner' ? 'the boss' : (this.core.employees.get(task.evidence.review.reviewerId)?.name ?? 'reviewer')}): ${task.evidence.review.comments}`);
        if (task.evidence.merge && !task.evidence.merge.ok) fb.push(`Merge into ${task.evidence.merge.into} conflicted: ${task.evidence.merge.detail}\nIn your worktree run "git merge ${project.integrationBranch}", resolve the conflicts, commit, re-run the tests and call complete_task again.`);
        text = taskPrompt(task, project, deps, fb.length ? fb.join('\n\n') : null, [this.eng.improver.capture.onboardingBlock(employee, project), this.eng.improver.playbookBlock(employee, project.id, true, task)].filter(Boolean).join('\n\n'), sharing.map((t) => `${this.core.employees.get(t.assigneeId)?.name ?? 'a colleague'} (${t.key})`), [...this.eng.talk.promptLines(task, employee), ...[this.eng.release.instructions(employee)].filter(Boolean)]);
        // What people attached to the task, copied to this machine: where each file is, for the Read tool.
        const files = await this.eng.attachments.deliver(task, employee).catch(() => []);
        const missing = (task.attachments ?? []).filter((a) => a.kind === 'input').length - files.length;
        if (files.length) text += `\n\nAttached files — open each with the Read tool before you start (an image opened that way is shown to you):\n${files.map((f) => `- ${f.path}${f.image ? ' (image)' : ''}${f.caption ? ` — ${f.caption}` : ''}`).join('\n')}`;
        if (missing > 0) text += `\n\n${missing} attached file${missing === 1 ? '' : 's'} could not be copied to this machine. Say so with report_blocker if you cannot do the task without ${missing === 1 ? 'it' : 'them'}.`;
        // What the office already knows about this subject, if its memory has something close — and only if it answers in time.
        if (this.eng.memory.available() && !this.core.hosts.get(project.hostId ?? '')?.memberId) {
          const remembered = await this.eng.memory.recallText(`${task.title}. ${truncate(task.description, 300)}`, { results: 3, timeoutMs: this.core.timings.memoryRecallMs ?? 20_000, chars: 500 }).catch(() => '');
          if (remembered) text += `\n\nFrom the office's memory — earlier work, answers and decisions that look related. They may be out of date: check before you rely on one, and use recall to ask for more.\n${remembered}`;
        }
      }
      // (Copying the files and asking the memory took a while: the task may have been stopped meanwhile — then the
      // "stopped" message is what they get, not the task after it.)
      if (takenBack() || this.core.tasks.get(task.id)?.status !== 'IN_PROGRESS') return;
      this.eng.comms.deliver(employee.id, 'TASK', task.id, { kind: 'task', id: task.id }, text);
    } catch (e) {
      if (takenBack()) return;
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
      this.core.event({ type: 'task.delivered', source: 'server', summary: `${task.key} was handed to ${emp?.name ?? 'employee'} (${state.via === 'stop_hook' ? 'via Stop hook' : state.via === 'codex' ? 'through Codex' : state.via === 'sdk' ? 'through the Agent SDK' : 'typed into the terminal'})`, taskId, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, via: state.via, quiet: true } });
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
    // Said on the task: what the boss writes there next is the answer, and brings the task back.
    this.eng.talk.blocked(task, employee, needs ? `I cannot go on: ${reason}\nWhat I need: ${needs}` : `I cannot go on: ${reason}`);
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
    if (directsOthers(to.roleKey)) return { text: `${to.name} is ${to.roleKey === 'foreman' ? 'the foreman' : 'a team lead'} and does not take tasks. Hand it to someone who does the work.`, isError: true };
    // Someone from another project (the specialist for this, in an office of small projects) is lent to this one.
    const cannot = this.lend(to, task.projectId);
    if (cannot) return { text: cannot, isError: true };
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
    this.eng.talk.add(task, { from: { kind: 'employee', id: from.id, name: from.name }, body: `Handed over to ${to.name}:\n${note}`, kind: 'handoff', mentions: [{ kind: 'employee', id: to.id, name: to.name }] }, { store: false, quiet: true });
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
  /**
   * `threaded`: what unblocks it was said in the task's conversation (an answer, the parts being done) — it reaches
   * the employee from there, and is not written into the task's description as well. `from`: who the message that
   * brings it back is from, when it is neither the boss nor `by`.
   */
  unblock(taskId: string, note: string, actor = 'owner', by?: Employee, opts: { threaded?: boolean; from?: Message['from'] } = {}): Task {
    const task = this.core.tasks.require(taskId);
    if (task.status !== 'BLOCKED') throw new EngineError(`${task.key} is not blocked`);
    const employee = this.core.employees.get(task.assigneeId);
    const previous = task.blockedReason;
    // Unblocked by a button or a colleague's tool rather than by an answer on the task: its open question is closed with this.
    if (!opts.threaded) this.eng.talk.unblocked(task, note, by ? { kind: 'employee', id: by.id, name: by.name } : actor === 'owner' ? { kind: 'owner', id: null, name: 'The boss' } : actor === 'office' ? { kind: 'office', id: null, name: 'The office' } : { kind: 'member', id: null, name: actor.replace(/^[a-z]+:/, '') });
    const waited = task.waitingFor ?? null;
    task.waitingFor = null;
    task.blockedReason = null;
    this.eng.comms.resolveNotifications((n) => n.taskId === task.id && (n.kind === 'blocked' || n.kind === 'merge_conflict'));
    const session = employee ? this.core.runningSessionOf(employee.id) : undefined;
    const stillTheirs = employee && session && task.worktree && path.resolve(session.cwd) === path.resolve(task.worktree) && !this.currentTask(employee.id);
    if (stillTheirs && task.delivery.status !== 'none') {
      // Same session, same workspace: resume in place with the owner's note.
      task.status = 'IN_PROGRESS';
      this.history(task, `Unblocked: ${note}`, actor);
      this.core.put('task', task);
      // (Somebody who unblocks their own task knows it: no message to themselves, which would only cost them a turn.)
      if (by?.id !== employee!.id) {
        const from: Message['from'] = opts.from ?? (by ? { kind: 'employee', id: by.id, name: `${by.name} (${by.title})` } : { kind: 'owner', id: null, name: 'the boss' });
        const body =
          waited?.kind === 'answer'
            ? `${by ? by.name : 'The boss'} answered on ${task.key}: ${note}\nGo on with the task with this.`
            : waited?.kind === 'parts'
              ? note
              : `${task.key} is unblocked (was: ${previous ?? 'blocked'}). ${note}\nContinue the task.`;
        this.eng.comms.sendMessage({ from, toEmployeeId: employee!.id, body, kind: 'system', taskId: task.id });
      }
      if (session!.activity === 'blocked') this.eng.sessions.setActivity(session!, 'idle', null);
    } else {
      task.status = 'READY';
      task.released = true;
      // (Said in the conversation: the task's prompt carries the conversation, so the description is left as it is.)
      if (note && !opts.threaded) task.description = `${task.description}\n\nNote from ${by ? by.name : 'the boss'} after a blocker (${previous ?? 'blocked'}): ${note}`.trim();
      this.history(task, `Unblocked and requeued: ${note}`, actor);
      this.core.put('task', task);
    }
    this.eng.memory.unblocked(task, previous, note, by ? by.name : 'the boss');
    this.core.event({ type: 'task.unblocked', source: by ? 'mcp' : 'owner', summary: by ? `${by.name} unblocked ${task.key}` : `${task.key} was unblocked`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, note } });
    this.schedule();
    return task;
  }

  // ────────────────────── completion & verification ────────────────

  /**
   * An agent called complete_task. Returns the text the agent receives; a
   * failed check comes back as a tool error so the agent keeps working.
   */
  async completeFromAgent(employee: Employee, args: { summary: string; tests_run?: string; no_code_changes?: boolean; release_plan?: string }): Promise<{ text: string; isError?: boolean }> {
    const task = this.currentTask(employee.id);
    if (!task) return { text: 'You have no task in progress. Use get_current_task or get_available_tasks.', isError: true };
    if (this.verifying.has(task.id)) return { text: `Verification of ${task.key} is already running; wait for its result.`, isError: true };
    // Divided into parts that are not all done: it is not finished, it waits for them.
    if (this.eng.talk.partsOf(task).some((p) => p.status !== 'DONE')) {
      const text = this.eng.talk.waitForParts(task, employee, String(args.summary ?? ''));
      this.afterEmployeeFreed(employee);
      return { text };
    }
    const project = this.core.projects.require(task.projectId);
    const hostId = this.core.runningSessionOf(employee.id)?.hostId ?? employee.hostId;
    if (!hostId || !this.core.agents.isOnline(hostId)) return { text: 'Your host is not reachable by Orchestrator right now; try complete_task again shortly.', isError: true };
    this.verifying.add(task.id);
    try {
      task.evidence.summary = args.summary;
      task.evidence.reportedTests = args.tests_run ?? null;
      // Where it goes once approved (the release gate, release.ts): the plan the owner reads in review.
      const plan = typeof args.release_plan === 'string' && args.release_plan.trim() ? truncate(args.release_plan.trim(), 4000) : null;
      task.release = plan ? { plan } : null;
      const codeTask = !NON_CODE_KINDS.has(task.kind);
      const cwd = task.worktree;

      if (task.kind === 'review' && task.reviewOf) {
        const target = this.core.tasks.get(task.reviewOf);
        // (A verdict that sent the work on to the boss is a verdict: the reviewer's own task is finished by it.)
        // And a task that has gone on without them — a colleague approved it first — waits for no verdict of theirs.
        if (target && target.status === 'REVIEW' && !target.evidence.review && !target.evidence.peerReview && target.reviewStage !== 'boss') {
          return { text: `You have not submitted your verdict yet. Call submit_review for ${target.key} first, then complete_task.`, isError: true };
        }
      }

      if (cwd && task.branch) {
        const st = await this.core.agents.rpc(hostId, { method: 'git.status', params: { cwd } });
        if (st.branch !== task.branch && project.workspace === 'in_place' && st.branch && st.branch !== 'HEAD') {
          // In place the office creates, switches and merges nothing: the branch is only where the work is looked for.
          // A team that never commits on its main branch works on one of its own — the task follows it (it was refused
          // on the live office, and the employee could only block).
          this.history(task, `The work is on the branch "${st.branch}" (the task started on "${task.branch}")`, 'orchestrator');
          task.branch = st.branch;
        }
        if (st.branch !== task.branch) {
          return { text: `Not complete: your worktree is on branch "${st.branch}" but ${task.key} must be on "${task.branch}". Switch back with: git switch ${task.branch}`, isError: true };
        }
        if (project.workspace === 'in_place') {
          // The owner's folder: only what became uncommitted during this task counts. Files that
          // were already uncommitted before it started are the owner's and are never the employee's to tidy.
          const theirs = new Set(task.baseDirty ?? []);
          let mine = st.files.filter((f: any) => !theirs.has(f.path));
          // Colleagues work (or worked) in this folder during the task: what they left uncommitted is not this task's
          // to tidy. Its own are the files its session wrote.
          const shared = !!task.sharedWith?.length || this.sharing(task, employee, cwd).length > 0;
          if (shared) {
            const touched = new Set(task.touched ?? []);
            const others = mine.filter((f: any) => !touched.has(f.path));
            mine = mine.filter((f: any) => touched.has(f.path));
            if (others.length && !mine.length) this.history(task, `Left as they are — uncommitted files not known to be this task's (the folder is shared${task.sharedWith?.length ? ` with ${task.sharedWith.join(', ')}` : ''}): ${others.slice(0, 8).map((f: any) => f.path).join(', ')}${others.length > 8 ? ', …' : ''}`, 'orchestrator');
          }
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
        // Where the branch stands now: this is what is checked, reviewed and merged.
        task.evidence.headSha = task.evidence.commits[0]?.sha ?? null;
        if (!task.evidence.commits.length && codeTask && !args.no_code_changes) {
          return { text: `Not complete: there are no commits on "${task.branch}" since the task started. Commit your work, or — only if the task truly needed no repository changes here, or the commits it needed were already made elsewhere (before it started, on another branch, by a colleague) — call complete_task with no_code_changes=true and say why in the summary, naming those commits.`, isError: true };
        }
        const diff = await this.core.agents.rpc(hostId, { method: 'git.diff', params: { cwd, base, maxBytes: 2000 } });
        task.evidence.filesChanged = diff.files ?? [];
        task.evidence.diffStat = diff.stat || null;
      }

      const own = codeTask ? (task.verifyCommand ?? project.verifyCommand) : null;
      // No command of the project's own: the office checks what it can — that the files the task changed still parse
      // (syntax-check.ts). In the owner's folder, where colleagues commit on the same branch, only the files this
      // task's session wrote. Paths are the repository's; the check runs in the task's folder.
      const changed = project.workspace === 'in_place' && task.touched?.length ? task.evidence.filesChanged.filter((f) => task.touched!.includes(f)) : task.evidence.filesChanged;
      const root = task.repoRoot ?? cwd;
      const fromHere = (f: string) => (root && cwd && path.resolve(root) !== path.resolve(cwd) ? path.relative(cwd, path.join(root, f)) : f);
      const syntax = !own && codeTask && cwd && project.policy.syntaxCheck !== false ? syntaxCheckScript(changed.map(fromHere)) : null;
      const command = own ?? syntax?.script ?? null;
      const label = own ?? (syntax ? SYNTAX_LABEL : null);
      const kind = own ? ('command' as const) : ('syntax' as const);
      let res: any = null;
      if (command && label && cwd) {
        this.core.put('task', task);
        this.core.event({ type: 'task.verifying', source: 'server', summary: `Verifying ${task.key}: ${label}`, taskId: task.id, projectId: project.id, employeeId: employee.id, data: { key: task.key, command: label } });
        const timeoutMs = Math.max(5, project.verifyTimeoutSec) * 1000;
        try {
          res = await this.core.agents.rpc(hostId, { method: 'verify.run', params: { cwd, command, timeoutMs } }, timeoutMs + 20000);
        } catch (e) {
          task.evidence.verification = { ts: nowIso(), command: label, exitCode: null, passed: null, outputTail: (e as Error).message, durationMs: null, provenance: 'unavailable', kind };
          this.core.put('task', task);
          // The office's own syntax check is a help, not the project's rule: when it cannot run, the work goes on unchecked.
          if (kind === 'command') return { text: `Orchestrator could not run the verification command (${(e as Error).message}). Tell the boss with report_blocker if this persists.`, isError: true };
          res = null;
        }
      }
      if (command && label && cwd && res && kind === 'syntax' && res.exitCode === 0 && !res.timedOut && syntaxChecked(res.outputTail) === 0) {
        // Nothing it knows how to check could be checked on that machine (the tools are not there): not measured.
        task.evidence.verification = { ts: nowIso(), command: label, exitCode: null, passed: null, outputTail: res.outputTail, durationMs: res.durationMs, provenance: 'unavailable', kind };
      } else if (command && label && cwd && res) {
        const passed = res.exitCode === 0 && !res.timedOut;
        task.evidence.verification = { ts: nowIso(), command: label, exitCode: res.exitCode, passed, outputTail: res.outputTail, durationMs: res.durationMs, provenance: 'measured', kind };
        this.core.company.verificationsRun++;
        if (!passed) {
          task.attempts++;
          task.friction.failedVerifications++;
          this.history(task, `Verification failed (${res.timedOut ? 'timed out' : `exit ${res.exitCode}`})`, 'orchestrator');
          this.core.put('task', task);
          this.core.saveCompany();
          this.core.event({ type: 'task.verification_failed', source: 'server', summary: `${task.key} failed verification (${kind === 'syntax' ? 'a changed file does not parse' : res.timedOut ? 'timeout' : `exit ${res.exitCode}`})`, taskId: task.id, projectId: project.id, employeeId: employee.id, data: { key: task.key, command: label, exitCode: res.exitCode, timedOut: res.timedOut, outputTail: truncate(res.outputTail, 1500) } });
          // The same failure on another task of this project is a fact about the project, not about this task.
          this.eng.improver.capture.onVerificationFailed(task, project, label, res);
          this.eng.comms.resolveNotifications((n) => n.kind === 'test_failure' && n.taskId === task.id);
          this.eng.comms.notify({ kind: 'test_failure', severity: 'warning', title: `${task.key} failed verification`, body: `${employee.name}'s work did not pass "${label}". They have been told to fix it.`, taskId: task.id, projectId: project.id, employeeId: employee.id });
          const timeoutMs = Math.max(5, project.verifyTimeoutSec) * 1000;
          return {
            text:
              kind === 'syntax'
                ? `Not complete: a file ${task.key} changed does not parse. The office checked the changed files where it runs (${res.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : 'php -l, node --check and the like'}):\n\n${res.outputTail}\n\nFix it, commit, and call complete_task again. If the check itself is wrong here (for example this machine's PHP is older than the one the project runs on), say so with report_blocker — the boss can switch the check off for the project.`
                : `Verification FAILED for ${task.key}. Orchestrator ran "${label}" in your worktree: ${res.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exit code ${res.exitCode}`}.\n\nOutput (tail):\n${res.outputTail}\n\nThe task is not complete. Fix the problem, commit, and call complete_task again.`,
            isError: true,
          };
        }
        this.core.company.testsPassed++;
        this.core.saveCompany();
        this.eng.comms.resolveNotifications((n) => n.kind === 'test_failure' && n.taskId === task.id);
        // It passed — by its own tests, if the task rewrote them. That is said, and somebody else looks at it.
        const touched = kind === 'command' ? checksTouched(task.evidence.filesChanged, command) : [];
        if (touched.length) {
          task.evidence.verification.touchedChecks = touched;
          this.history(task, `Verification passed, but the task changed what it is checked by: ${touched.slice(0, 6).join(', ')}${touched.length > 6 ? ` and ${touched.length - 6} more` : ''}`, 'orchestrator');
          // (A task that is about the tests themselves is expected to change them: noted, not held up — when a
          // person made it such a task. An employee who names its own task "test" has not excused it from review.)
          const aboutTests = task.kind === 'test' && !/^employee:/.test(task.createdBy ?? '');
          if (!aboutTests && !task.requiresReview) {
            task.requiresReview = true;
            task.reviewBy = this.usualReview(project);
            this.core.event({ type: 'task.updated', source: 'server', summary: `${task.key} passed its checks after changing them (${touched[0]}${touched.length > 1 ? ` and ${touched.length - 1} more` : ''}): it goes to review`, taskId: task.id, projectId: project.id, employeeId: employee.id, data: { key: task.key, touchedChecks: touched } });
          }
        }
      } else if (!(command && label && cwd)) {
        task.evidence.verification = { ts: nowIso(), command: null, exitCode: null, passed: null, outputTail: '', durationMs: null, provenance: 'unavailable' };
      }

      task.progress = { percent: 100, note: 'Completion reported', ts: nowIso() };
      // With the release gate on, work that goes somewhere is approved by an owner, always: a colleague's review is the
      // first step of it, and work nobody was to review goes to the boss (the owner, 2026-11-23: "always the owner").
      if (task.release?.plan && this.eng.release.on() && task.kind !== 'review') {
        const was = reviewByOf(task);
        if (was === 'none' || was === 'peer') {
          task.requiresReview = true;
          task.reviewBy = was === 'none' ? 'boss' : 'both';
          this.history(task, `It goes somewhere once approved (a release plan): an owner approves it${was === 'peer' ? ' after the colleague' : ''} (the release gate)`, 'orchestrator');
        }
      }
      if (task.requiresReview && task.kind !== 'review' && task.evidence.review?.verdict !== 'approved') {
        task.status = 'REVIEW';
        // Whoever handed it in is its author for this review, also if the task is given to somebody else meanwhile.
        task.authorId = task.assigneeId;
        task.evidence.review = null;
        task.evidence.peerReview = null;
        this.history(task, 'Verified; waiting for review', 'orchestrator');
        this.eng.talk.add(task, { from: { kind: 'employee', id: employee.id, name: employee.name }, body: args.summary, kind: 'handed_in', mentions: [] }, { store: false, quiet: true });
        this.core.put('task', task);
        const reviewer = this.requestReview(task, null);
        this.afterEmployeeFreed(employee);
        const then = reviewer && reviewByOf(task) === 'both' ? ', and then by the boss' : '';
        return { text: `${task.key} passed Orchestrator's checks and is now waiting for review by ${reviewer ? reviewer.name : 'the boss'}${then}. You are free; wait for the next task or for review feedback.` };
      }
      this.eng.talk.add(task, { from: { kind: 'employee', id: employee.id, name: employee.name }, body: args.summary, kind: 'handed_in', mentions: [] }, { store: false, quiet: true });
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
  /**
   * `asItStands`: merge the branch as it is now, not the commit that was checked — only on a person's own "Retry
   * merge": that is how a conflict resolved by hand in the author's folder (a commit made after the check, by or
   * with the owner) gets in, and whoever presses it has looked.
   */
  async finalize(task: Task, opts: { asItStands?: boolean } = {}): Promise<void> {
    const project = this.core.projects.require(task.projectId);
    const employee = this.core.employees.get(task.assigneeId);
    const hostId = employee ? (this.core.runningSessionOf(employee.id)?.hostId ?? employee.hostId) : project.hostId;
    // In-place projects have nothing to merge: the commits are already on the folder's own branch.
    const mergeable = project.workspace !== 'in_place' && !!task.branch && !!task.worktree && task.evidence.commits.length > 0 && project.policy.autoMerge && !NON_CODE_KINDS.has(task.kind);
    if (mergeable && (!hostId || !employee || !this.core.agents.isOnline(hostId))) {
      // The work is there and approved, and it cannot be merged right now (its machine is away, or nobody holds the
      // task any more). It is not "done" until it is in: tasks that wait for it would start without it.
      task.status = 'BLOCKED';
      task.blockedReason = `${WAITS_FOR_MERGE} ${project.integrationBranch}: ${employee ? `${employee.name}'s machine is not reachable right now` : 'nobody is assigned to it any more'}. Retry the merge when it is.`;
      // (Recorded as a merge that has not happened, so that "Retry merge" is there for it — and the office retries
      // by itself when the machine is back: see `mergeWaiting`.)
      task.evidence.merge = { ts: nowIso(), ok: false, sha: null, into: project.integrationBranch, detail: 'Not attempted yet: the machine the work is on could not be reached.' };
      this.history(task, task.blockedReason, 'orchestrator');
      this.core.put('task', task);
      this.core.event({ type: 'task.blocked', source: 'server', summary: `${task.key} is approved but could not be merged yet`, taskId: task.id, projectId: project.id, employeeId: task.assigneeId, data: { key: task.key, reason: task.blockedReason } });
      return;
    }
    if (mergeable && hostId && employee) {
      const repo = this.repoFor(project, employee);
      if (repo && this.core.agents.isOnline(hostId)) {
        const insp = await this.core.agents.rpc(hostId, { method: 'fs.inspect', params: { path: repo } });
        const paths = this.worktreePaths(insp.repoRoot ?? repo, employee);
        const res = await this.chainMerge(`${hostId}:${insp.repoRoot ?? repo}`, () =>
          this.core.agents.rpc(hostId, {
            method: 'git.merge',
            params: { repo: insp.repoRoot ?? repo, worktree: paths.integration, into: project.integrationBranch, base: project.baseBranch, branch: task.branch!, message: `Merge ${task.key}: ${task.title}`, sha: opts.asItStands ? null : (task.evidence.headSha ?? null) },
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
        if (res.leftOut) {
          this.history(task, `${res.leftOut} commit${res.leftOut === 1 ? '' : 's'} made on ${task.branch} after the work was checked ${res.leftOut === 1 ? 'was' : 'were'} not merged: only what was verified${task.requiresReview ? ' and reviewed' : ''} is`, 'orchestrator');
          this.eng.comms.notify({ kind: 'info', severity: 'warning', title: `${task.key}: commits after the check were left out of the merge`, body: `${employee.name} made ${res.leftOut} more commit${res.leftOut === 1 ? '' : 's'} on ${task.branch} after ${task.key} was handed in. What was merged is the commit that was checked (${String(task.evidence.headSha).slice(0, 7)}); the later ${res.leftOut === 1 ? 'one is' : 'ones are'} still on the branch, in nobody's work.`, employeeId: employee.id, taskId: task.id, projectId: project.id });
        }
        // The task passed on its own branch; now check the integration branch with it merged in.
        if (!res.alreadyMerged) void this.testIntegration(project, hostId, insp.repoRoot ?? repo, `after merging ${task.key}`, task.id).catch(() => undefined);
        this.core.event({ type: 'task.merged', source: 'server', summary: `${task.key} merged into ${project.integrationBranch}`, taskId: task.id, projectId: project.id, employeeId: task.assigneeId, data: { key: task.key, sha: res.sha, alreadyMerged: res.alreadyMerged } });
      }
    }
    task.status = 'DONE';
    task.blockedReason = null;
    task.waitingFor = null;
    task.reviewStage = null;
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
    // A part of a larger task: said there, and the last one brings that task back to whoever leads it.
    if (task.parentId) this.eng.talk.partSettled(task, 'done');
    this.schedule();
  }

  /** Owner action after resolving a conflict by hand. */
  /** A machine is back: approved work on it that was waiting to be merged is merged now. */
  mergeWaiting(hostId: string): void {
    for (const t of this.core.tasks.filter((x) => x.status === 'BLOCKED' && !!x.blockedReason?.startsWith(WAITS_FOR_MERGE))) {
      const e = this.core.employees.get(t.assigneeId);
      if (!e || (this.core.runningSessionOf(e.id)?.hostId ?? e.hostId) !== hostId) continue;
      void this.retryMerge(t.id, 'office').catch((err) => this.core.log('warn', `merging ${t.key} after its machine came back: ${(err as Error).message}`));
    }
  }

  async retryMerge(taskId: string, actor = 'owner'): Promise<Task> {
    const task = this.core.tasks.require(taskId);
    if (task.status !== 'BLOCKED' || !task.evidence.merge || task.evidence.merge.ok) throw new EngineError(`${task.key} is not waiting on a merge`);
    this.core.audit(actor, 'task.retry_merge', taskId, { key: task.key });
    // A person's retry merges the branch as it stands now (they resolved the conflict there, or saw to it); the
    // office's own retry — the machine came back — merges the commit that was checked, as always.
    const byPerson = actor !== 'office';
    if (byPerson && task.evidence.headSha) this.history(task, `Merge retried by ${actor === 'owner' ? 'the boss' : actor.replace(/^[a-z]+:/, '')}: the branch is merged as it stands now`, actor);
    await this.finalize(task, { asItStands: byPerson });
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

  /**
   * Is this one a code reviewer for this task: the Code Reviewer, or for a security task the security reviewer too.
   * They come first for every review (the owner, 2026-11-18: "for tasks, when there is a review, the code reviewers
   * have priority, and only then somebody else").
   */
  isCodeReviewer(e: Pick<Employee, 'roleKey'>, task: Pick<Task, 'kind'>): boolean {
    return e.roleKey === 'reviewer' || (task.kind === 'security' && e.roleKey === 'security');
  }

  /**
   * Reviewers by trade who may take this task's review, best first: by trade (a code reviewer before an architect,
   * a QA), then whoever is free, then the project's own before one from elsewhere. A code reviewer is found across
   * the office — one of no project, or of another project on the machine the project lives on (lent to it for the
   * review); an architect or a QA only on the project, as before. Never across the line to a member's own computer
   * (the review would carry the task's text there, and its reviewer could not hand the review in).
   */
  private reviewersByTrade(task: Task): Employee[] {
    const preferred = task.kind === 'security' ? ['security', 'reviewer', 'architect'] : ['reviewer', 'architect', 'security', 'qa'];
    const project = this.core.projects.get(task.projectId);
    const tier = (e: Employee) => (e.projectId === task.projectId || e.alsoProjectIds?.includes(task.projectId) ? 0 : e.projectId === null ? 1 : 2);
    const pool = this.core.employees.filter(
      (e) =>
        !e.archived && e.id !== task.assigneeId && !task.helperIds?.includes(e.id) && preferred.includes(e.roleKey) && !!e.hostId && e.schedule.available && this.canSee(e, task) &&
        (e.executionMode !== 'codex_managed' || !this.eng.sessions.cannotStart(e)) &&
        (tier(e) < 2 || (this.isCodeReviewer(e, task) && (!project?.hostId || project.hostId === e.hostId))),
    );
    const rank = (e: Employee) => preferred.indexOf(e.roleKey) * 6 + (this.isFree(e) ? 0 : 3) + tier(e);
    return pool.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  /** The code reviewer this task's review goes to, when there is one to take it. */
  codeReviewerFor(task: Task): Employee | undefined {
    const first = this.reviewersByTrade(task)[0];
    return first && this.isCodeReviewer(first, task) ? first : undefined;
  }

  private pickReviewer(task: Task): Employee | undefined {
    const pool = this.reviewersByTrade(task);
    if (pool[0] || this.core.settings.employeesManageBoard === false) return pool[0];
    // No reviewer by trade on the team. Where employees keep the board themselves, a colleague who does this kind of
    // work reviews it — a second pair of eyes from the team, instead of the task waiting for the boss. Never the
    // author, never a foreman or a person's own session, never across the line to a member's own computer.
    const author = this.core.employees.get(task.assigneeId);
    const peers = this.core.employees.filter(
      (e) => !e.archived && e.id !== task.assigneeId && !task.helperIds?.includes(e.id) && !directsOthers(e.roleKey) && !e.selfDriven && !!e.hostId && e.schedule.available && this.canSee(e, task) && (e.projectId === task.projectId || !!e.alsoProjectIds?.includes(task.projectId)),
    );
    const rank = (e: Employee) => {
      const does = roleByKey(e.roleKey)?.handles.includes(task.kind) ? 0 : 2;
      const sameTrade = author && e.roleKey === author.roleKey ? 0 : 1;
      const busy = this.isFree(e) ? 0 : 1;
      return does * 4 + sameTrade * 2 + busy;
    };
    return peers.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))[0];
  }

  /**
   * Somebody from another project is given work on this one by a colleague: they are lent to it — they keep their
   * own project and folder, and can be routed work here. (When the owner assigns across projects the employee moves,
   * as before.) Refused across the line between the shared office and a member's own computer.
   */
  lend(to: Employee, projectId: string): string | null {
    if (to.projectId === projectId || to.alsoProjectIds?.includes(projectId)) return null;
    const project = this.core.projects.get(projectId);
    const personal = (hostId: string | null | undefined) => !!this.core.hosts.get(hostId ?? '')?.memberId;
    if ((personal(to.hostId) || personal(project?.hostId)) && to.hostId !== project?.hostId) return `${to.name} cannot take work of ${project?.name ?? 'that project'}: work does not cross between the shared office and a member's own computer.`;
    if (!to.projectId) return null; // nobody's yet: they simply come here with the task
    to.alsoProjectIds = [...(to.alsoProjectIds ?? []), projectId];
    this.core.put('employee', to);
    this.core.event({ type: 'employee.updated', source: 'server', summary: `${to.name} also works on ${project?.name ?? 'another project'} now (given work there by a colleague)`, employeeId: to.id, projectId, data: { lentTo: projectId, quiet: true } });
    return null;
  }

  /** Ask for a review of a task. Returns the reviewing employee, or null when the owner reviews. */
  requestReview(task: Task, reviewerRef: string | null, notes?: string): Employee | null {
    const author = this.core.employees.get(task.assigneeId);
    let reviewer: Employee | undefined;
    // Reviewed by the boss alone: no colleague is asked.
    const bossOnly = reviewByOf(task) === 'boss';
    if (!bossOnly) {
      if (reviewerRef && author) reviewer = this.eng.comms.resolveTeammate(author, reviewerRef);
      reviewer = reviewer ?? this.core.employees.get(task.reviewerId) ?? this.pickReviewer(task);
      // Whoever was named: not the author, not the foreman, not somebody on the other side of the line.
      if (reviewer && (reviewer.id === task.assigneeId || task.helperIds?.includes(reviewer.id) || directsOthers(reviewer.roleKey) || reviewer.archived || !this.canSee(reviewer, task))) reviewer = this.pickReviewer(task);
      if (reviewer && reviewer.id === task.assigneeId) reviewer = undefined;
      // A code reviewer comes first: a colleague named by the author (or the one of an earlier round) who is not one
      // gives way to a code reviewer who can take it.
      const code = reviewer && this.isCodeReviewer(reviewer, task) ? undefined : this.codeReviewerFor(task);
      if (code) {
        if (reviewer) this.history(task, `${reviewer.name} was to review it; ${code.name}, the code reviewer, reviews it instead (code reviewers come first)`, 'orchestrator');
        reviewer = code;
      }
      // One from another project is lent to this one for the review: they keep their own.
      if (reviewer && reviewer.projectId && reviewer.projectId !== task.projectId && !reviewer.alsoProjectIds?.includes(task.projectId) && this.lend(reviewer, task.projectId)) reviewer = this.pickReviewer(task);
    }
    task.reviewStage = reviewer ? 'peer' : 'boss';
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
      this.core.put('task', task);
      this.eng.comms.notify({ kind: 'review', severity: 'warning', title: `${task.key} needs your review`, body: `${author?.name ?? 'An employee'} finished "${task.title}". ${bossOnly ? 'It' : 'No colleague can review it, so it'} is waiting for you.`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId });
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

  /** `who`: the person, when it is one (their name stands on the verdict; `by` is then 'owner'). */
  async submitReview(by: Employee | 'owner', taskRef: string, verdict: 'approve' | 'request_changes', comments: string, who?: Person, opts: { checked?: string | null } = {}): Promise<Task> {
    const task = this.taskByKey(taskRef, by === 'owner' ? null : by.projectId);
    if (!task) throw new EngineError(`no task "${taskRef}"`);
    if (task.status !== 'REVIEW') throw new EngineError(`${task.key} is not waiting for review (status ${task.status})`);
    if (by !== 'owner') {
      if (by.id === task.assigneeId || by.id === task.authorId) throw new EngineError('you cannot review your own task');
      // Measured on the live office: reviewers who had done part of the work themselves approved it ("not an
      // independent review", in their own words). Who worked on it does not judge it.
      if (task.helperIds?.includes(by.id)) throw new EngineError(`you worked on ${task.key} with its author: somebody who did not do the work reviews it`);
      const assigned = task.reviewerId === by.id || !!this.core.tasks.find((t) => t.reviewOf === task.id && t.assigneeId === by.id);
      // With the board in the employees' hands, any colleague may review finished work — never its own author.
      if (!assigned && this.core.settings.employeesManageBoard === false) throw new EngineError(`you were not asked to review ${task.key}`);
      if (!this.canSee(by, task)) throw new EngineError(`no task "${taskRef}"`);
      // A colleague has approved it already: what it waits for now is the boss.
      if (task.reviewStage === 'boss' && task.evidence.contested) throw new EngineError(`${task.key} was sent back ${REVIEW_SEND_BACKS} times already and now waits for the boss`);
      if (task.reviewStage === 'boss' && task.evidence.peerReview) throw new EngineError(`${task.key} was approved by ${this.core.employees.get(task.evidence.peerReview.reviewerId)?.name ?? 'a colleague'} and now waits for the boss`);
    }
    const approved = verdict === 'approve';
    if (!approved && !comments.trim()) throw new EngineError('say what should change: it is what the author reads');
    // What the reviewer ran or opened to reach the verdict. Code nothing of the office's tested is approved only on
    // a check somebody made and named (measured on the live office: half of the reviews ran nothing).
    // A session started before "checked" was a field of submit_review has the tool without it: a "Checked: …" line in
    // the comments is the same.
    const inComments = /(?:^|\n)\s*\**checked\**\s*:\s*([\s\S]+)$/i.exec(comments)?.[1]?.trim();
    const checked = typeof opts.checked === 'string' && opts.checked.trim() ? truncate(opts.checked.trim(), 2000) : inComments ? truncate(inComments, 2000) : null;
    if (approved && by !== 'owner' && !NON_CODE_KINDS.has(task.kind) && !testedByOffice(task) && (checked ?? '').length < 12)
      throw new EngineError(
        `nothing the office ran tests ${task.key}, so an approval says what you checked: run what shows it works (the test that covers it, the page or the request on the development server, the query) and give "checked" — what you ran and what it showed (if your submit_review has no "checked", end the comments with a line "Checked: …"). Nothing was recorded.`,
      );
    if (!approved && by !== 'owner' && task.friction.reviewRejections >= REVIEW_SEND_BACKS) return this.contest(task, by, comments);
    task.evidence.contested = null;
    task.evidence.review = { reviewerId: by === 'owner' ? null : by.id, verdict: approved ? 'approved' : 'changes_requested', comments, ts: nowIso(), by: by === 'owner' ? 'owner' : 'employee', checked };
    const said = (text: string) => (checked && !/(?:^|\n)\s*\**checked\**\s*:/i.test(text) ? `${text}\n\nChecked: ${checked}` : text);
    this.core.company.reviewsCompleted++;
    this.core.saveCompany();
    const reviewerName = by === 'owner' ? (who && who.kind !== 'owner' ? who.name : 'The boss') : by.name;
    const from = by === 'owner' ? { kind: who?.kind ?? ('owner' as const), id: who?.id ?? null, name: reviewerName } : { kind: 'employee' as const, id: by.id, name: by.name };
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
    if (approved && by !== 'owner' && reviewByOf(task) === 'both') {
      // A colleague's approval is the first of two: the work goes on to the boss.
      task.evidence.peerReview = { reviewerId: by.id, comments, ts: nowIso(), checked };
      task.evidence.review = null;
      task.reviewStage = 'boss';
      this.history(task, `Approved by ${reviewerName}; waiting for the boss`, reviewerName);
      this.eng.talk.add(task, { from, body: said(comments.trim() || 'Approved.'), kind: 'approved', mentions: [] }, { store: false, quiet: true });
      this.core.put('task', task);
      this.eng.comms.notify({ kind: 'review', severity: 'warning', title: `${task.key} needs your review`, body: `${this.core.employees.get(task.authorId ?? task.assigneeId)?.name ?? 'An employee'} finished "${task.title}" and ${reviewerName} approved it${comments.trim() ? `: ${truncate(comments, 200)}` : '.'}${checked ? `\nChecked: ${truncate(checked, 300)}` : testedByOffice(task) || NON_CODE_KINDS.has(task.kind) ? '' : `\n${reviewerName} did not say what they checked, and the office ran no tests on it.`}`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId });
      this.closeStaleReviews();
      return task;
    }
    if (approved) {
      this.history(task, `Review approved by ${reviewerName}`, reviewerName);
      this.eng.talk.add(task, { from, body: said(comments.trim() || 'Approved.'), kind: 'approved', mentions: [] }, { store: false, quiet: true });
      await this.finalize(task);
      // A person approved it: the gate opens for those who release it (release.ts). A colleague's approval does not.
      if (by === 'owner' && (task.status as string) === 'DONE') this.eng.release.approved(task, who?.name ?? 'The boss');
    } else {
      this.eng.talk.add(task, { from, body: said(comments), kind: 'sent_back', mentions: [] }, { store: false, quiet: true });
      task.reviewStage = null;
      task.evidence.peerReview = null;
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
    // Whoever else was asked to review it has nothing left to review.
    this.closeStaleReviews();
    return task;
  }

  /**
   * A colleague asks for changes on work that was sent back `REVIEW_SEND_BACKS` times already. Another round between
   * the two of them is what this stops: each one costs a turn of the author and a turn of the reviewer, and what is
   * still found by the third is as a rule either small, or a disagreement only the boss can settle. The task stays
   * in review and waits for the boss, with what the colleague asked for; the boss approves it as it is, or sends it
   * back in their own words.
   */
  private contest(task: Task, by: Employee, comments: string): Task {
    task.evidence.contested = { reviewerId: by.id, comments, ts: nowIso() };
    task.evidence.peerReview = null;
    task.evidence.review = null;
    task.reviewStage = 'boss';
    this.core.company.reviewsCompleted++;
    this.core.saveCompany();
    this.history(task, `${by.name} asked for changes after ${REVIEW_SEND_BACKS} rounds: waiting for the boss`, by.name);
    this.eng.talk.add(task, { from: { kind: 'employee', id: by.id, name: by.name }, body: `Still asks for changes, after ${REVIEW_SEND_BACKS} rounds — for the boss to decide: ${comments.trim()}`, kind: 'note', mentions: [] }, { store: false, quiet: true });
    this.core.put('task', task);
    this.core.event({ type: 'task.review_completed', source: 'mcp', summary: `${by.name} asked for changes on ${task.key} once more: it waits for the boss`, taskId: task.id, projectId: task.projectId, employeeId: by.id, data: { key: task.key, verdict: 'contested', comments: truncate(comments, 600), reviewerId: by.id } });
    this.eng.comms.resolveNotifications((n) => n.kind === 'review' && n.taskId === task.id);
    this.eng.comms.notify({ kind: 'review', severity: 'warning', title: `${task.key} needs your decision`, body: `"${task.title}" was sent back ${REVIEW_SEND_BACKS} times, and ${by.name} still asks for changes: ${truncate(comments, 400)} — Approve it as it is, or send it back yourself.`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId });
    this.closeStaleReviews();
    return task;
  }

  /** Does this task still wait for a colleague's verdict? (Not once one is given, or once it is the boss's turn.) */
  private waitsForPeer(task: Task): boolean {
    return task.status === 'REVIEW' && task.reviewStage !== 'boss' && !task.evidence.review && !task.evidence.peerReview;
  }

  /** In a sentence, where a task that no longer waits for a colleague's review has gone. */
  private movedOn(task: Task): string {
    const name = (id: string | null | undefined, by?: string) => (by === 'owner' ? 'the boss' : (this.core.employees.get(id)?.name ?? 'a colleague'));
    const v = task.evidence.review;
    if (v?.verdict === 'approved') return `${task.key} was approved by ${name(v.reviewerId, v.by)}`;
    if (v) return `${name(v.reviewerId, v.by)} sent ${task.key} back with changes to make`;
    if (task.evidence.peerReview) return `${task.key} was approved by ${name(task.evidence.peerReview.reviewerId)} and now waits for the boss`;
    if (task.evidence.contested && task.status === 'REVIEW') return `${task.key} was sent back ${REVIEW_SEND_BACKS} times and now waits for the boss`;
    if (task.status === 'REVIEW') return `${task.key} now waits for the boss`;
    return `${task.key} is no longer waiting for a review (it is ${task.status === 'DONE' ? 'done' : task.status === 'BLOCKED' ? 'blocked' : 'back with its author'})`;
  }

  /**
   * Reviews nobody waits for any more are closed by the office. A task leaves a colleague's review by more roads than
   * that colleague's own verdict: somebody who was not asked approves it first, the boss approves it or sends it back,
   * it is stopped or moved by hand. The review a colleague was asked for is then a ticket with no way out —
   * submit_review has nothing to decide, and it would sit open (or blocked, in the boss's Inbox) for good.
   *
   * One that had not been started is taken away. One somebody was reading is finished as "not needed any more" and
   * its reviewer is told. The reviewer whose verdict it was finishes their own ticket, as always.
   */
  closeStaleReviews(): number {
    let n = 0;
    for (const r of this.core.tasks.filter((t) => t.kind === 'review' && !!t.reviewOf && t.status !== 'DONE')) {
      const target = this.core.tasks.get(r.reviewOf);
      if (!target || this.waitsForPeer(target) || this.verifying.has(r.id)) continue;
      const theirs = !!r.assigneeId && (target.evidence.review?.reviewerId === r.assigneeId || target.evidence.peerReview?.reviewerId === r.assigneeId);
      if (theirs && r.status === 'IN_PROGRESS') continue;
      n++;
      this.eng.comms.cancelFor({ kind: 'task', id: r.id });
      if (!r.startedAt && (r.status === 'READY' || r.status === 'BACKLOG')) {
        this.core.remove('task', r.id);
        continue;
      }
      const why = this.movedOn(target);
      const reviewer = this.core.employees.get(r.assigneeId);
      const wasTheirs = r.status === 'IN_PROGRESS' || r.status === 'BLOCKED';
      for (const q of this.core.questions.filter((x) => x.taskId === r.id && x.status === 'open' && x.channel !== 'system')) this.eng.comms.supersede(q.id, `${r.key} was closed: ${why}.`);
      r.status = 'DONE';
      r.blockedReason = null;
      r.waitingFor = null;
      r.completedAt = nowIso();
      r.evidence.summary = `Not needed any more: ${why}${theirs ? '' : ' before this review was finished'}.`;
      this.history(r, `Closed by the office: ${why}`, 'orchestrator');
      this.core.put('task', r);
      this.eng.comms.resolveNotifications((x) => x.taskId === r.id);
      this.core.event({ type: 'task.updated', source: 'server', summary: `${r.key} was closed: ${why}`, taskId: r.id, projectId: r.projectId, employeeId: r.assigneeId, data: { key: r.key, status: 'DONE', reviewOf: target.id, closedByOffice: true } });
      if (reviewer && wasTheirs && !theirs) {
        this.eng.comms.sendMessage({
          from: { kind: 'system', id: null, name: 'the office' },
          toEmployeeId: reviewer.id,
          kind: 'system',
          taskId: r.id,
          body: `Your review ${r.key} is closed: ${why} while you were on it. Nothing waits for you there — do not call submit_review, complete_task or report_blocker for it. If you found something that should still be said, write it on ${target.key} with comment_on_task. You are free for the next task.`,
        });
        this.afterEmployeeFreed(reviewer);
      }
    }
    return n;
  }

  /**
   * A verdict that comes after the task has gone on, from a reviewer who had been asked for one: nothing is decided
   * by it any more, and what they found is not thrown away — it is written on the ticket as a second opinion.
   * Returns what the reviewer is told, or null when this is an ordinary verdict (or nobody's to give).
   */
  secondOpinion(by: Employee, taskRef: string, verdict: 'approve' | 'request_changes', comments: string): string | null {
    const task = this.taskByKey(taskRef, by.projectId);
    if (!task || this.waitsForPeer(task) || by.id === task.assigneeId || by.id === task.authorId || !this.canSee(by, task)) return null;
    const asked = this.core.tasks.filter((t) => t.reviewOf === task.id && t.assigneeId === by.id);
    if (!asked.length) return null;
    // (Their own verdict, given once, is not given again as an opinion.)
    if (task.evidence.review?.reviewerId === by.id || task.evidence.peerReview?.reviewerId === by.id) return null;
    const why = this.movedOn(task);
    const said = comments.trim();
    this.eng.talk.add(task, { from: { kind: 'employee', id: by.id, name: by.name }, body: `Second opinion (${verdict === 'approve' ? 'would approve' : 'would ask for changes'}), given after ${why}${said ? `: ${said}` : '.'}`, kind: 'note', mentions: [] }, { quiet: true });
    this.closeStaleReviews();
    // (A ticket of theirs that is still open — theirs to read, nobody's to wait for — ends here.)
    for (const r of asked.filter((t) => t.status !== 'DONE')) {
      r.status = 'DONE';
      r.blockedReason = null;
      r.completedAt = nowIso();
      r.evidence.summary = `Not needed any more: ${why}. A second opinion was left on ${task.key}.`;
      this.history(r, `Closed by the office: ${why}`, 'orchestrator');
      this.core.put('task', r);
      this.eng.comms.resolveNotifications((x) => x.taskId === r.id);
    }
    return `${why}, so your verdict decides nothing there. It is written on ${task.key} as a second opinion, where the boss and ${this.core.employees.get(task.assigneeId)?.name ?? 'its author'} read it. Your review is finished: do not call complete_task or report_blocker for it.`;
  }

  /**
   * A finished task is sent back: opened again for whoever did it, with what should change as the feedback of the
   * next attempt. What was done stays where it is (merged, committed); the new work is measured from where the
   * folder stands now, on a fresh branch where the project uses branches, and is checked and reviewed like any other.
   */
  reopen(taskId: string, note: string, who: Person): Task {
    const task = this.core.tasks.require(taskId);
    if (task.status !== 'DONE') throw new EngineError(`${task.key} is not done`);
    if (task.kind === 'review') throw new EngineError('a review is not opened again; send back the task it reviewed');
    const name = who.kind === 'owner' ? 'The boss' : who.name;
    const actor = who.kind === 'owner' ? 'owner' : `member:${who.name}`;
    const text = this.eng.vault.capture(truncate(note.trim(), 4000), { kind: 'owner', id: null, name }, [this.core.projects.get(task.projectId)?.name ?? '']).text;
    const author = this.core.employees.get(task.assigneeId);
    if (!author || author.archived) task.assigneeId = null;
    task.status = 'READY';
    task.released = true;
    task.completedAt = null;
    task.attempts++;
    task.friction.reviewRejections++;
    task.reopened = (task.reopened ?? 0) + 1;
    task.evidence.review = { reviewerId: null, verdict: 'changes_requested', comments: text, ts: nowIso(), by: 'owner' };
    task.evidence.peerReview = null;
    task.evidence.merge = null;
    task.reviewStage = null;
    // The next attempt is new work: it is measured from where things stand when it starts.
    task.branch = null;
    task.worktree = null;
    task.baseSha = null;
    task.baseDirty = null;
    task.touched = [];
    task.sharedWith = [];
    task.nudges = 0;
    task.progress = { percent: null, note: null, ts: null };
    task.delivery = { status: 'none', via: null, ts: null, detail: null };
    if (PRIORITY_ORDER[task.priority] > PRIORITY_ORDER.high) task.priority = 'high';
    this.history(task, `Opened again by ${name}: ${truncate(text, 200)}`, actor);
    this.eng.talk.add(task, { from: { kind: who.kind, id: who.id, name }, body: text, kind: 'sent_back', mentions: [] }, { store: false, quiet: true });
    this.core.put('task', task);
    this.eng.comms.resolveNotifications((n) => n.taskId === task.id && n.kind === 'task_completed');
    this.core.audit(actor, 'task.reopened', task.id, { key: task.key });
    this.core.event({ type: 'task.reopened', source: 'owner', summary: `${task.key} was sent back by ${name}: ${truncate(text, 120)}`, taskId: task.id, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, note: truncate(text, 600) } });
    // What the owner says about finished work is a lesson candidate for its author, as in a review.
    if (who.kind === 'owner') this.eng.improver.capture.onReviewRejected(task, text);
    this.schedule();
    return task;
  }

  /**
   * Once, when the office first runs with "every task is reviewed unless chosen otherwise" (2026-11-12): every task
   * that is not finished — and is neither a review nor a part — is to be reviewed the way the office reviews.
   * Finished tasks, tasks already in review, and whatever is chosen afterwards are left alone.
   */
  adoptReviewDefault(): number {
    if (this.core.store.kvGet<number>('tasks.reviewByDefault', 0) >= 1) return 0;
    let n = 0;
    const usual = reviewDefaultOf(this.core.settings);
    if (usual !== 'none') {
      for (const t of this.core.tasks.filter((x) => x.status !== 'DONE' && x.status !== 'REVIEW' && x.kind !== 'review' && !x.parentId && !x.requiresReview)) {
        t.requiresReview = true;
        t.reviewBy = usual;
        this.core.put('task', t);
        n++;
      }
    }
    this.core.store.kvSet('tasks.reviewByDefault', 1);
    if (n) this.core.audit('office', 'tasks.review_default', 'tasks', { count: n });
    return n;
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
    // Everybody named must exist and be able to take work here — checked before anything is created.
    const whom = specs.map((spec, i) => {
      const name = String(spec?.assignee ?? '').trim();
      if (!name) return null;
      const to = name.toLowerCase() === by.name.toLowerCase() ? by : this.eng.comms.resolveTeammate(by, name);
      if (!to || to.archived) throw new EngineError(`task ${i} ("${truncate(String(spec?.title ?? ''), 40)}"): no teammate matches "${name}". Use get_team for exact names.`);
      if (directsOthers(to.roleKey)) throw new EngineError(`task ${i}: ${to.name} is ${to.roleKey === 'foreman' ? 'the foreman' : 'a team lead'} and does not take tasks.`);
      return to;
    });
    for (const [i, to] of whom.entries()) {
      const cannot = to ? this.lend(to, projectId) : null;
      if (cannot) throw new EngineError(`task ${i}: ${cannot}`);
    }
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
      const task = this.createTask({ projectId, title: spec.title.trim(), description: spec.description ?? '', acceptance: spec.acceptance ?? '', kind, priority, roleHint: whom[i] ? null : (role?.key ?? null), assigneeId: whom[i]?.id ?? null, dependsOn: deps, released: auto && !key, dedupeKey: key }, `employee:${by.name}`);
      created.push(task);
      at.push(task);
    }
    const released = !created.some((t) => !t.released);
    if (rationale?.trim() && created.length) {
      this.eng.addArtifact({ kind: 'plan', title: `Plan by ${by.name} (${origin})`, content: `${rationale.trim()}\n\n${created.map((t) => `- **${t.key}** ${t.title}${t.roleHint ? ` _(${t.roleHint})_` : ''}${t.dependsOn.length ? ` — after ${t.dependsOn.map((d) => this.core.tasks.get(d)?.key).join(', ')}` : ''}`).join('\n')}`, projectId, employeeId: by.id });
    }
    if (!released) {
      // One line per employee and project while it is unread: what they have proposed and is still waiting, counted
      // anew — not a line for every proposal (the live office had 32 lines of "proposed 1 tasks" from one employee).
      const waiting = this.core.tasks.filter((t) => t.projectId === projectId && !t.released && t.status === 'BACKLOG' && t.createdBy === `employee:${by.name}`).length || created.filter((t) => !t.released).length;
      const title = `${by.name} proposed ${waiting === 1 ? 'a task' : `${waiting} tasks`}`;
      const body = `${waiting === 1 ? 'It is' : 'They are'} in the backlog of ${project.name} until you release ${waiting === 1 ? 'it' : 'them'}.`;
      const open = this.core.notifications.find((n) => n.kind === 'info' && n.employeeId === by.id && n.projectId === projectId && !n.readAt && !n.resolvedAt && / proposed (a task|\d+ tasks)$/.test(n.title));
      if (open) this.core.put('notification', { ...open, title, body, createdAt: nowIso() });
      else this.eng.comms.notify({ kind: 'info', severity: 'warning', title, body, projectId, employeeId: by.id });
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

/** Paths that are tests, or settings of what runs them. */
const CHECK_PATHS = [
  /(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright)\//i,
  /(^|\/)[^/]*[._-](test|spec)\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]*\.py$/i,
  /(^|\/)[^/]*_test\.(go|py|rb|exs?)$/i,
  // A script whose name says it is the check (what `npm test` usually runs when it is not a test runner).
  /(^|\/)(check|checks|verify|test|tests|run-?tests|lint)\.(c?js|mjs|ts|sh|py)$/i,
  /(^|\/)(jest|vitest|playwright|cypress|karma|mocha|ava|babel)\.config\.[a-z]+$/i,
  /(^|\/)(pytest\.ini|tox\.ini|conftest\.py|\.mocharc[^/]*|phpunit\.xml(\.dist)?|Makefile|justfile)$/i,
  /(^|\/)\.(github\/workflows|gitlab-ci|circleci)(\/|\.yml$)/i,
];

/**
 * Which of the files a task changed are part of what it is verified by: tests, the test runner's settings, and
 * whatever file the verification command itself names (`node check.js`, `sh scripts/verify.sh`). `package.json`
 * counts when the command goes through it (`npm test`, `pnpm run …`, `yarn …`).
 */
export function checksTouched(filesChanged: string[], command: string | null): string[] {
  const scripts = scriptsRun(command ?? '');
  const viaPackage = /\b(npm|pnpm|yarn|bun)\b/.test(command ?? '');
  const clean = (f: string) => f.replace(/^[A-Z?]{1,2}\s+/, '').replace(/^.* -> /, '').trim();
  return [...new Set(filesChanged.map(clean).filter((f) => !!f && (CHECK_PATHS.some((re) => re.test(f)) || scripts.includes(f) || (viaPackage && /(^|\/)package\.json$/.test(f)))))];
}

const INTERPRETERS = new Set(['node', 'sh', 'bash', 'zsh', 'python', 'python3', 'ruby', 'perl', 'php', 'deno', 'bun', 'tsx', 'ts-node', 'npx']);

/**
 * The files a command line runs as programs: `node check.js`, `sh scripts/verify.sh`, `./verify.sh`. A file the
 * command only looks at (`test -f totals.txt`, `grep -q ON a.txt`) is what is being checked, not the check.
 */
function scriptsRun(command: string): string[] {
  const out: string[] = [];
  const path = (w: string) => w.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '');
  for (const segment of command.split(/&&|\|\||[;|()]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const first = words[0]!;
    if (INTERPRETERS.has(first)) {
      // The first argument that is not an option; `-c` / `-e` mean the program is written inline, so there is no file.
      const rest = words.slice(1);
      if (rest.some((w) => /^-(c|e|-eval|-command)$/.test(w))) continue;
      const file = rest.find((w) => !w.startsWith('-'));
      if (file) out.push(path(file));
    } else if (/^\.{0,2}\//.test(first) || /\.(sh|c?js|mjs|ts|py|rb)$/.test(first)) out.push(path(first));
  }
  return out;
}

