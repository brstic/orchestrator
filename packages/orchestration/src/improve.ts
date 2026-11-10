import type { Employee, EvidenceRef, Improvement, ImprovementAction, ImprovementKind, Lesson, LessonSource, PerformanceStat, Project, Question, Task, TaskKind } from '@orchestrator/contracts';
import { correlationMarker, newId, nowIso, truncate } from '@orchestrator/contracts';
import { EngineError } from './core.ts';
import type { Engine } from './engine.ts';
import { Autopilot, AUTOPILOT_ACTOR } from './learning/autopilot.ts';
import { DEFAULT_HIGH_RISK_PATTERNS } from './prompts.ts';
import { Playbook } from './learning/playbook.ts';
import { Capture, type LessonArgs } from './learning/capture.ts';
import { Outcomes, routingEvidence } from './learning/outcomes.ts';

const MAX_LESSONS_IN_PROMPT = 12;
/** Approvals of the same command shape before Orchestrator suggests pre-approving it. */
const APPROVALS_BEFORE_SUGGESTING = 3;

/**
 * Self-improvement, for the workers and for Orchestrator itself.
 *
 * Workers improve through a playbook: after work that hit real friction (a
 * failed verification, rejected review, merge conflict…), the employee's own
 * Claude Code session is shown the recorded facts and asked what it would do
 * differently. What it records is kept with its evidence and fed into that
 * employee's future prompts. The owner's answers become shared project
 * knowledge so the same question is not asked twice.
 *
 * Orchestrator improves by reading its own history: it routes work using
 * measured outcomes per employee and task kind, and proposes changes to
 * policy and process when the record supports them. Which of those it may apply
 * by itself is the autopilot's decision (`learning/autopilot.ts`): changes that
 * widen what agents may do without asking wait for the owner unless the dial is
 * on `trusted`, and then only under evidence thresholds and on probation.
 */
export class Improver {
  private eng: Engine;
  /** Retrospective in progress per employee: lessons they record are tied to that task. */
  private retros = new Map<string, { taskId: string; recorded: number }>();
  private analyzeTimer: NodeJS.Timeout | null = null;
  /** Which lessons a task prompt carries, and keeping the lessons free of duplicates (learning/playbook.ts). */
  readonly playbook: Playbook;
  /** What is learned from the record itself: corrections, rejections, repeats, failures (learning/capture.ts). */
  readonly capture: Capture;
  /** Whether what was learned helped: outcomes, trends, verdicts on lessons and applied improvements (learning/outcomes.ts). */
  readonly outcomes: Outcomes;
  /** Applies what the dial allows by itself, keeps undo records, and takes its own changes back on a counter-signal. */
  readonly autopilot: Autopilot;

  constructor(eng: Engine) {
    this.eng = eng;
    this.playbook = new Playbook(eng, (p) => this.propose(p));
    this.capture = new Capture(eng);
    this.outcomes = new Outcomes(eng);
    this.autopilot = new Autopilot(eng);
  }

  private get core() {
    return this.eng.core;
  }

  private get on(): boolean {
    return this.core.settings.selfImprovement.enabled;
  }

  // ─────────────────────────── playbooks ───────────────────────────

  /** Active lessons that apply to an employee: their own, their project's, the company's. */
  lessonsFor(employee: Employee, projectId: string | null): Lesson[] {
    if (!this.on) return [];
    const rank = (l: Lesson) => (l.scope === 'employee' ? 0 : l.scope === 'project' ? 1 : 2);
    return this.core.lessons
      .filter((l) => l.status === 'active' && ((l.scope === 'employee' && l.employeeId === employee.id) || (l.scope === 'project' && !!projectId && l.projectId === projectId) || l.scope === 'company'))
      .sort((a, b) => rank(a) - rank(b) || (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, MAX_LESSONS_IN_PROMPT);
  }

  /**
   * The block added to prompts. Counts each inclusion so usage is visible. With the task the prompt
   * is for, the lessons are chosen by how well they fit it (learning/playbook.ts) and the choice is
   * recorded on the task; without one (a system prompt, a Talk message) they are the newest by scope.
   */
  playbookBlock(employee: Employee, projectId: string | null, count = true, task: Task | null = null): string {
    const fitted = task && this.on ? this.playbook.forTask(employee, task, count) : null;
    const lessons = fitted ?? this.lessonsFor(employee, projectId);
    if (!lessons.length) return '';
    if (count && !fitted) {
      for (const l of lessons) {
        l.appliedCount++;
        this.core.lessons.put(l);
      }
    }
    const line = (l: Lesson) => `- ${l.text}${l.appliesWhen ? ` (applies ${l.appliesWhen.replace(/^when\s+/i, 'when ')})` : ''}`;
    const own = lessons.filter((l) => l.scope === 'employee');
    const shared = lessons.filter((l) => l.scope !== 'employee');
    return [
      own.length ? `Lessons from your own earlier work here — apply them:\n${own.map(line).join('\n')}` : '',
      shared.length ? `Team knowledge and decisions already made by the boss — do not ask these again:\n${shared.map(line).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private saveLesson(input: {
    scope: Lesson['scope'];
    employeeId: string | null;
    projectId: string | null;
    text: string;
    appliesWhen: string;
    source: LessonSource;
    evidence: EvidenceRef[];
    status: Lesson['status'];
    authoredBy: Lesson['authoredBy'];
  }): Lesson {
    const text = input.text.trim().replace(/\s+/g, ' ');
    if (text.length < 8) throw new EngineError('a lesson needs to be a full sentence');
    // Learned twice, in the same or in other words: strengthen the record instead of repeating it.
    const duplicate = this.playbook.absorb({ ...input, text });
    if (duplicate) return duplicate;
    const lesson: Lesson = {
      id: newId().slice(0, 8),
      scope: input.scope,
      employeeId: input.employeeId,
      projectId: input.projectId,
      text: truncate(text, 400),
      appliesWhen: truncate(input.appliesWhen.trim(), 160),
      source: input.source,
      evidence: input.evidence,
      status: input.status,
      authoredBy: input.authoredBy,
      appliedCount: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.core.put('lesson', lesson);
    this.core.event({
      type: 'improvement.lesson_recorded',
      source: input.authoredBy.kind === 'employee' ? 'mcp' : input.authoredBy.kind === 'owner' ? 'owner' : 'server',
      summary: `${input.authoredBy.name} recorded a lesson${input.status === 'proposed' ? ' (awaiting your approval)' : ''}: ${truncate(text, 120)}`,
      employeeId: input.employeeId ?? (input.authoredBy.kind === 'employee' ? input.authoredBy.id : null),
      projectId: input.projectId,
      taskId: input.evidence.find((e) => e.kind === 'task')?.id ?? null,
      data: { lessonId: lesson.id, scope: lesson.scope, source: lesson.source, status: lesson.status },
    });
    // What a second employee of the project learns independently becomes the project's.
    this.playbook.afterSave(lesson);
    if (lesson.status === 'proposed') {
      // (A candidate for one employee's playbook is not a team lesson: say whose it would be.)
      this.eng.comms.notify({ kind: 'improvement', severity: 'info', title: lesson.scope === 'employee' ? `${input.authoredBy.name} proposes a lesson for ${this.core.employees.get(lesson.employeeId)?.name ?? 'an employee'}` : `${input.authoredBy.name} proposes a team lesson`, body: lesson.text, employeeId: input.authoredBy.id ?? lesson.employeeId, projectId: lesson.projectId });
    }
    return lesson;
  }

  /** A candidate lesson derived from the record (learning/capture.ts): saved like any other, so it is merged and ranked like any other. */
  saveCandidate(input: { scope: Lesson['scope']; employeeId: string | null; projectId: string | null; text: string; appliesWhen: string; source: LessonSource; evidence: EvidenceRef[]; status: Lesson['status']; authoredBy: Lesson['authoredBy'] }): Lesson {
    return this.saveLesson(input);
  }

  /** A worker's own session records what it learned (the record_lesson tool). */
  recordFromAgent(employee: Employee, args: LessonArgs): string {
    if (!this.on) return 'Self-improvement is switched off in this office; nothing was recorded.';
    const retro = this.retros.get(employee.id);
    // The fixed shape of a lesson: a vague one is sent back here, with what is missing.
    const checked = this.capture.check(employee, args);
    if (checked.none) {
      this.retros.delete(employee.id);
      this.capture.nothingLearned(employee, retro?.taskId ?? null, checked.reason);
      return 'Noted: nothing to record from this one.';
    }
    const task = retro ? this.core.tasks.get(retro.taskId) : this.eng.tasks.currentTask(employee.id);
    const shared = checked.scope !== 'employee';
    const projectId = task?.projectId ?? employee.projectId;
    const lesson = this.saveLesson({
      scope: shared ? (projectId && checked.scope === 'project' ? 'project' : 'company') : 'employee',
      employeeId: shared ? null : employee.id,
      projectId: shared && checked.scope === 'project' ? projectId : null,
      text: checked.rule,
      appliesWhen: checked.when,
      source: 'retrospective',
      evidence: task ? [{ kind: 'task', id: task.id, note: `${task.key} ${task.title}` }] : [],
      // A worker may shape its own playbook freely; rules for everyone else go past the owner.
      status: shared && !this.core.settings.selfImprovement.autoApproveSharedLessons ? 'proposed' : 'active',
      authoredBy: { kind: 'employee', id: employee.id, name: employee.name },
    });
    if (retro && ++retro.recorded >= 3) this.retros.delete(employee.id);
    const revised = this.capture.recorded(lesson, employee, task, checked, args.replaces);
    return `${lesson.status === 'proposed' ? `Recorded as a proposal for the team (id ${lesson.id}); the boss decides whether it becomes shared knowledge.` : `Recorded in ${shared ? 'the team knowledge' : 'your playbook'} (id ${lesson.id}). It will be included in your future task prompts.`}${revised}`;
  }

  /** The owner teaches directly. */
  recordFromOwner(input: { text: string; appliesWhen?: string; scope: Lesson['scope']; employeeId?: string | null; projectId?: string | null }, actor = 'owner'): Lesson {
    if (input.scope === 'employee') this.core.employees.require(input.employeeId ?? '');
    if (input.scope === 'project') this.core.projects.require(input.projectId ?? '');
    this.core.audit(actor, 'lesson.created', input.scope, { text: truncate(input.text, 120) });
    return this.saveLesson({
      scope: input.scope,
      employeeId: input.scope === 'employee' ? input.employeeId! : null,
      projectId: input.scope === 'project' ? input.projectId! : null,
      text: input.text,
      appliesWhen: input.appliesWhen ?? '',
      source: 'owner',
      evidence: [],
      status: 'active',
      authoredBy: { kind: 'owner', id: null, name: this.core.settings.ownerName },
    });
  }

  updateLesson(id: string, patch: { text?: string; appliesWhen?: string; status?: Lesson['status'] }, actor = 'owner'): Lesson {
    const l = this.core.lessons.require(id);
    if (patch.text !== undefined) {
      if (patch.text.trim().length < 8) throw new EngineError('a lesson needs to be a full sentence');
      l.text = truncate(patch.text.trim(), 400);
    }
    if (patch.appliesWhen !== undefined) l.appliesWhen = truncate(patch.appliesWhen.trim(), 160);
    if (patch.status !== undefined) {
      if (!['proposed', 'active', 'retired'].includes(patch.status)) throw new EngineError('invalid status');
      l.status = patch.status;
    }
    l.updatedAt = nowIso();
    this.core.put('lesson', l);
    this.core.audit(actor, 'lesson.updated', id, patch);
    this.core.event({ type: 'improvement.lesson_updated', source: 'owner', summary: `Lesson ${patch.status ? `set to ${patch.status}` : 'edited'}: ${truncate(l.text, 100)}`, employeeId: l.employeeId, projectId: l.projectId, data: { lessonId: id, status: l.status } });
    return l;
  }

  /**
   * A decision the owner gave once becomes project knowledge, in the owner's
   * own words, so no employee has to ask it again.
   */
  captureOwnerAnswer(q: Question): void {
    if (!this.on || q.kind === 'permission' || q.kind === 'trust_prompt' || q.kind === 'merge_conflict' || q.kind === 'priority') return;
    const answer = q.answers && Object.keys(q.answers).length ? Object.entries(q.answers).map(([k, v]) => `${k} → ${v}`).join('; ') : q.answer;
    if (!answer?.trim()) return;
    const asker = this.core.employees.get(q.employeeId);
    // Strip any test/automation directives the answer may carry; knowledge is the decision itself.
    const clean = answer.replace(/@@[\s\S]*?@@/g, '').trim();
    if (!clean) return;
    this.saveLesson({
      scope: q.projectId ? 'project' : 'company',
      employeeId: null,
      projectId: q.projectId,
      text: `Decided by the boss — "${truncate(q.text, 180)}": ${truncate(clean, 200)}`,
      appliesWhen: asker ? `this comes up again (first asked by ${asker.name})` : '',
      source: 'owner_answer',
      evidence: [{ kind: 'question', id: q.id, note: truncate(q.text, 120) }],
      status: 'active',
      authoredBy: { kind: 'owner', id: null, name: this.core.settings.ownerName },
    });
  }

  // ───────────────────────── retrospectives ────────────────────────

  hadFriction(task: Task): boolean {
    const f = task.friction;
    return f.failedVerifications + f.reviewRejections + f.mergeConflicts + f.blockers + f.questions + f.denials > 0 || task.nudges > 0;
  }

  /** A task was verified done: ask its author to reflect, when there is something to reflect on. */
  afterTask(task: Task): void {
    this.scheduleAnalyze();
    if (this.on && task.kind !== 'review') this.capture.refreshSkills(task.assigneeId);
    if (!this.on || task.kind === 'review' || !task.assigneeId) return;
    const mode = this.core.settings.selfImprovement.retrospectives;
    if (mode === 'off' || (mode === 'friction' && !this.hadFriction(task))) return;
    const employee = this.core.employees.get(task.assigneeId);
    const session = employee ? this.core.runningSessionOf(employee.id) : undefined;
    if (!employee || !session?.capabilities.mcp) return;
    // The facts in a structured form and the shape of a lesson — or nothing, when they already hold a lesson about exactly this.
    const retro = this.capture.retrospective(task, employee);
    if (!retro.text) return;
    this.retros.set(employee.id, { taskId: task.id, recorded: 0 });
    this.eng.comms.deliver(employee.id, 'RETRO', task.id, { kind: 'retro', id: task.id }, retro.text);
    this.core.event({ type: 'improvement.retrospective_requested', source: 'server', summary: `${employee.name} was asked to reflect on ${task.key}`, employeeId: employee.id, taskId: task.id, projectId: task.projectId, data: { key: task.key, facts: retro.facts.length, kinds: [...new Set(retro.facts.map((f) => f.kind))], revises: retro.revises?.id ?? null, quiet: true } });
  }

  // ─────────────────────────── performance ─────────────────────────

  /** Outcomes per employee and task kind, counted from task records. */
  performance(): PerformanceStat[] {
    const table = new Map<string, PerformanceStat>();
    for (const t of this.core.tasks.all()) {
      if (t.status !== 'DONE' || !t.assigneeId || t.kind === 'review' || !t.evidence.summary) continue;
      const key = `${t.assigneeId}:${t.kind}`;
      let row = table.get(key);
      if (!row) table.set(key, (row = { employeeId: t.assigneeId, kind: t.kind, completed: 0, firstPass: 0, failedVerifications: 0, reviewRejections: 0, mergeConflicts: 0 }));
      row.completed++;
      row.failedVerifications += t.friction.failedVerifications;
      row.reviewRejections += t.friction.reviewRejections;
      row.mergeConflicts += t.friction.mergeConflicts;
      if (t.friction.failedVerifications === 0 && t.friction.reviewRejections === 0) row.firstPass++;
    }
    // Each row also carries the same record with recent work counting more (`outcomes`).
    return this.outcomes.decorate([...table.values()]);
  }

  /**
   * Learned routing: among equally suitable employees, prefer the one whose
   * record on this kind of task is better. Needs at least two completed tasks
   * of that kind before it has an opinion. The record it reads is the decayed
   * one (old tasks fade, a short record speaks quietly): see `routingEvidence`.
   */
  routingBonus(employee: Employee, kind: TaskKind): { bonus: number; reason: string | null } {
    if (!this.on || !this.core.settings.selfImprovement.learnedRouting) return { bonus: 0, reason: null };
    return routingEvidence(this.performance().find((r) => r.employeeId === employee.id && r.kind === kind), kind);
  }

  // ───────────────────── orchestrator proposals ────────────────────

  scheduleAnalyze(): void {
    if (this.analyzeTimer || !this.on) return;
    this.analyzeTimer = setTimeout(() => {
      this.analyzeTimer = null;
      try {
        this.analyze();
      } catch (e) {
        this.core.log('warn', `improvement analysis failed: ${(e as Error).message}`);
      }
    }, 400);
    this.analyzeTimer.unref?.();
  }

  private propose(p: { kind: ImprovementKind; key: string; title: string; rationale: string; evidence: EvidenceRef[]; projectId?: string | null; employeeId?: string | null; action: ImprovementAction }): Improvement | null {
    if (this.core.improvements.find((i) => i.dedupeKey === p.key)) return null;
    const imp: Improvement = { id: newId().slice(0, 8), kind: p.kind, title: p.title, rationale: p.rationale, evidence: p.evidence.slice(0, 12), projectId: p.projectId ?? null, employeeId: p.employeeId ?? null, action: p.action, status: 'proposed', dedupeKey: p.key, createdAt: nowIso(), decidedAt: null };
    this.core.put('improvement', imp);
    this.core.event({ type: 'improvement.proposed', source: 'server', summary: `Orchestrator suggests: ${p.title}`, projectId: imp.projectId, employeeId: imp.employeeId, data: { improvementId: imp.id, kind: imp.kind } });
    this.eng.comms.notify({ kind: 'improvement', severity: 'info', title: `Suggestion: ${p.title}`, body: p.rationale, projectId: imp.projectId, employeeId: imp.employeeId });
    return imp;
  }

  private commandShape(command: string): string | null {
    const first = command.trim().split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? '';
    const words = first.split(/\s+/).filter(Boolean);
    if (!words.length || /[`$(){}<>]/.test(words.slice(0, 2).join(' '))) return null;
    const two = ['npm', 'pnpm', 'yarn', 'git', 'docker', 'cargo', 'go', 'make', 'npx', 'python', 'python3', 'php', 'composer', 'kubectl', 'pip', 'bundle'].includes(words[0]!) && words[1] && !words[1].startsWith('-');
    return two ? `${words[0]} ${words[1]}` : words[0]!;
  }

  private isHighRisk(command: string, project: Project | undefined): boolean {
    return [...DEFAULT_HIGH_RISK_PATTERNS, ...(project?.policy.highRiskPatterns ?? [])].some((p) => {
      try {
        return new RegExp(p, 'i').test(command);
      } catch {
        return false;
      }
    });
  }

  /** Read the record and propose changes it supports. Idempotent: each finding is proposed once. */
  analyze(): Improvement[] {
    if (!this.on) return [];
    const out: Improvement[] = [];
    const add = (i: Improvement | null) => {
      if (i) out.push(i);
    };
    const decided = this.core.questions.filter((q) => q.kind === 'permission' && !!q.decision && !!q.tool);

    // 0. The lessons themselves: merge reworded copies, promote what two employees both learned, flag contradictions.
    try {
      for (const i of this.playbook.consolidate().contradictions) add(i);
    } catch (e) {
      // Tidying the lessons must not stop the rest of the analysis.
      this.core.log('warn', `playbook consolidation failed: ${(e as Error).message}`);
    }

    // 1. The owner keeps approving the same kind of command → offer to pre-approve it.
    const shapes = new Map<string, { projectId: string; shape: string; allowed: Question[]; denied: Question[] }>();
    for (const q of decided) {
      if (q.tool!.name !== 'Bash' || !q.projectId) continue;
      const command = String((q.tool!.input as any)?.command ?? '');
      const shape = this.commandShape(command);
      if (!shape) continue;
      const key = `${q.projectId}:${shape}`;
      let g = shapes.get(key);
      if (!g) shapes.set(key, (g = { projectId: q.projectId, shape, allowed: [], denied: [] }));
      (q.decision === 'allow' ? g.allowed : g.denied).push(q);
    }
    for (const g of shapes.values()) {
      const project = this.core.projects.get(g.projectId);
      if (!project) continue;
      const rule = `Bash(${g.shape}:*)`;
      if (g.allowed.length >= APPROVALS_BEFORE_SUGGESTING && !g.denied.length && !project.policy.allow.includes(rule)) {
        // Never offer to pre-approve something the safety policy escalates on purpose.
        if (g.allowed.some((q) => this.isHighRisk(String((q.tool!.input as any)?.command ?? ''), project))) continue;
        add(
          this.propose({
            kind: 'allow_rule',
            key: `allow:${g.projectId}:${g.shape}`,
            title: `Pre-approve "${g.shape} …" in ${project.name}`,
            rationale: `You approved ${g.allowed.length} "${g.shape}" commands in ${project.name} and denied none. Adding the rule ${rule} lets employees on this project run them without asking. It takes effect for sessions started afterwards.`,
            evidence: g.allowed.map((q) => ({ kind: 'approval' as const, id: q.id, note: truncate(String((q.tool!.input as any)?.command ?? ''), 100) })),
            projectId: g.projectId,
            action: { type: 'project.policy.allow', projectId: g.projectId, rule },
          }),
        );
      }
      if (g.denied.length >= APPROVALS_BEFORE_SUGGESTING && !g.allowed.length && !project.policy.deny.includes(rule)) {
        add(
          this.propose({
            kind: 'deny_rule',
            key: `deny:${g.projectId}:${g.shape}`,
            title: `Block "${g.shape} …" in ${project.name}`,
            rationale: `You denied ${g.denied.length} "${g.shape}" commands in ${project.name} and approved none. Adding a deny rule stops employees from even asking.`,
            evidence: g.denied.map((q) => ({ kind: 'approval' as const, id: q.id, note: truncate(String((q.tool!.input as any)?.command ?? ''), 100) })),
            projectId: g.projectId,
            action: { type: 'project.policy.deny', projectId: g.projectId, rule },
          }),
        );
      }
    }

    // 2. A supervised employee whose edits are always approved and whose work passes → suggest more autonomy.
    for (const e of this.core.employees.filter((x) => !x.archived)) {
      const mine = decided.filter((q) => q.employeeId === e.id);
      const perf = this.performance().filter((r) => r.employeeId === e.id);
      const completed = perf.reduce((n, r) => n + r.completed, 0);
      const firstPass = perf.reduce((n, r) => n + r.firstPass, 0);
      if (e.autonomy === 'supervised' && mine.length >= 6 && mine.every((q) => q.decision === 'allow') && completed >= 2 && firstPass === completed) {
        add(
          this.propose({
            kind: 'autonomy',
            key: `autonomy-up:${e.id}:standard`,
            title: `Give ${e.name} standard autonomy`,
            rationale: `${e.name} is supervised. You approved all ${mine.length} of their requests, and all ${completed} of their completed tasks passed verification first time. Standard autonomy lets them edit files and run routine commands without asking; risky commands still come to you.`,
            evidence: mine.slice(-8).map((q) => ({ kind: 'approval' as const, id: q.id, note: truncate(q.text, 100) })),
            employeeId: e.id,
            action: { type: 'employee.autonomy', employeeId: e.id, level: 'standard' },
          }),
        );
      }
      // 3. Work that keeps failing first time → suggest a review gate (tightening, but still the owner's call).
      if (completed >= 4 && firstPass / completed < 0.5 && e.projectId) {
        const project = this.core.projects.get(e.projectId);
        if (project && !project.policy.requireReview) {
          add(
            this.propose({
              kind: 'review_policy',
              key: `review:${project.id}:${e.id}`,
              title: `Require review on ${project.name}`,
              rationale: `Only ${firstPass} of ${e.name}'s ${completed} completed tasks passed first time (${perf.reduce((n, r) => n + r.failedVerifications, 0)} failed verifications, ${perf.reduce((n, r) => n + r.reviewRejections, 0)} review rejections). Requiring review before merge would catch problems earlier.`,
              evidence: this.core.tasks.filter((t) => t.assigneeId === e.id && t.status === 'DONE' && t.friction.failedVerifications + t.friction.reviewRejections > 0).slice(-8).map((t) => ({ kind: 'task' as const, id: t.id, note: `${t.key} ${t.title}` })),
              projectId: project.id,
              employeeId: e.id,
              action: { type: 'project.requireReview', projectId: project.id, value: true },
            }),
          );
        }
      }
    }

    for (const project of this.core.projects.filter((p) => p.status !== 'archived')) {
      const tasks = this.core.tasks.filter((t) => t.projectId === project.id);
      // 4. Code tasks are being completed with nothing to verify them against.
      const unverified = tasks.filter((t) => t.status === 'DONE' && t.kind !== 'review' && t.kind !== 'research' && t.kind !== 'planning' && t.evidence.commits.length > 0 && t.evidence.verification?.provenance !== 'measured');
      if (!project.verifyCommand && unverified.length >= 3) {
        add(
          this.propose({
            kind: 'verify_command',
            key: `verify:${project.id}`,
            title: `Set a verification command for ${project.name}`,
            rationale: `${unverified.length} tasks with code changes were completed in ${project.name} without any measured verification, because the project has no verification command. Setting one (for example its test script) lets Orchestrator check completed work itself.`,
            evidence: unverified.slice(-8).map((t) => ({ kind: 'task' as const, id: t.id, note: `${t.key} ${t.title}` })),
            projectId: project.id,
            action: { type: 'advice' },
          }),
        );
      }
      // 5. Verification keeps timing out → the limit is wrong for this project.
      const timeouts = this.core.store.queryEvents({ projectId: project.id, types: ['task.verification_failed'], limit: 200 }).filter((e) => e.data.timedOut === true);
      if (timeouts.length >= 2) {
        const seconds = Math.min(3600, project.verifyTimeoutSec * 2);
        add(
          this.propose({
            kind: 'verify_timeout',
            key: `verify-timeout:${project.id}:${seconds}`,
            title: `Raise ${project.name}'s verification timeout to ${seconds}s`,
            rationale: `Verification timed out ${timeouts.length} times at the current ${project.verifyTimeoutSec}s limit. A timeout is reported to the employee as a failure, so they may be chasing problems that do not exist.`,
            evidence: timeouts.slice(-6).map((e) => ({ kind: 'event' as const, id: e.id, note: e.summary })),
            projectId: project.id,
            action: { type: 'project.verifyTimeout', projectId: project.id, seconds },
          }),
        );
      }
      // 6. The same people keep colliding in the same files → the work should be sequenced.
      const conflicts = this.core.store.queryEvents({ projectId: project.id, types: ['task.merge_conflict'], limit: 200 });
      const byFile = new Map<string, typeof conflicts>();
      for (const c of conflicts) for (const f of (c.data.conflicts as string[] | undefined) ?? []) byFile.set(f, [...(byFile.get(f) ?? []), c]);
      for (const [file, list] of byFile) {
        if (list.length < 2) continue;
        add(
          this.propose({
            kind: 'sequencing',
            key: `sequence:${project.id}:${file}`,
            title: `Sequence work that touches ${file}`,
            rationale: `${list.length} merges in ${project.name} conflicted in ${file}. When several tasks change this file, make them depend on each other so each starts from the previous result instead of in parallel.`,
            evidence: list.slice(-6).map((e) => ({ kind: 'event' as const, id: e.id, note: e.summary })),
            projectId: project.id,
            action: { type: 'advice' },
          }),
        );
      }
      // 7. Tasks without acceptance criteria fail verification more.
      const vague = tasks.filter((t) => t.kind !== 'review' && !t.acceptance.trim() && t.friction.failedVerifications + t.friction.reviewRejections >= 1);
      const clear = tasks.filter((t) => t.kind !== 'review' && !!t.acceptance.trim() && t.status === 'DONE');
      if (vague.length >= 4 && vague.length > clear.filter((t) => t.friction.failedVerifications + t.friction.reviewRejections >= 1).length * 2) {
        add(
          this.propose({
            kind: 'acceptance_criteria',
            key: `acceptance:${project.id}`,
            title: `Write acceptance criteria for tasks in ${project.name}`,
            rationale: `${vague.length} tasks without acceptance criteria failed verification or review at least once — more than twice as many as tasks that had criteria. Tasks handed over with explicit criteria are getting through cleaner.`,
            evidence: vague.slice(-8).map((t) => ({ kind: 'task' as const, id: t.id, note: `${t.key} ${t.title}` })),
            projectId: project.id,
            action: { type: 'advice' },
          }),
        );
      }
    }
    // 8. Did what was learned help? Retire lessons the record is against, mark the proven ones, suggest undoing a change that made things worse.
    for (const i of this.outcomes.act()) add(i);
    if (out.length) this.core.broadcast('performance', this.performance());
    // Every open proposal is looked at again, not only the new ones: evidence grows and the daily allowance refills.
    this.autopilot.run();
    return out;
  }

  /** The owner accepted a proposal: make the change, for real. */
  apply(id: string, actor = 'owner'): Improvement {
    const imp = this.core.improvements.require(id);
    if (imp.status !== 'proposed') throw new EngineError(`this suggestion was already ${imp.status}`, 409);
    const a = imp.action;
    const undoTicket = this.autopilot.before(imp);
    switch (a.type) {
      case 'project.policy.allow': {
        const p = this.core.projects.require(a.projectId);
        if (!p.policy.allow.includes(a.rule)) this.eng.tasks.updateProject(p.id, { policy: { allow: [...p.policy.allow, a.rule] } }, actor);
        break;
      }
      case 'project.policy.deny': {
        const p = this.core.projects.require(a.projectId);
        if (!p.policy.deny.includes(a.rule)) this.eng.tasks.updateProject(p.id, { policy: { deny: [...p.policy.deny, a.rule] } }, actor);
        break;
      }
      case 'project.requireReview':
        this.eng.tasks.updateProject(a.projectId, { policy: { requireReview: a.value } }, actor);
        break;
      case 'project.verifyTimeout':
        this.eng.tasks.updateProject(a.projectId, { verifyTimeoutSec: a.seconds }, actor);
        break;
      case 'employee.autonomy':
        this.eng.employees.update(a.employeeId, { autonomy: a.level }, actor);
        break;
      case 'advice':
        // "Take back the change that made things worse" (learning/outcomes.ts): accepting the suggestion does it.
        if (imp.kind === 'revert_improvement' && imp.outcomesRevertOf && this.core.improvements.get(imp.outcomesRevertOf)?.status === 'applied') this.autopilot.revert(imp.outcomesRevertOf, actor);
        break;
    }
    imp.status = 'applied';
    imp.decidedAt = nowIso();
    this.autopilot.after(imp, undoTicket, actor);
    this.core.put('improvement', imp);
    this.core.audit(actor, 'improvement.applied', id, { kind: imp.kind, action: a });
    // (When the office applied it by itself, the line for the feed is the autopilot's `learning.applied`, which carries the evidence.)
    const auto = actor === AUTOPILOT_ACTOR;
    this.core.event({ type: 'improvement.applied', source: auto ? 'server' : 'owner', summary: `Applied: ${imp.title}`, projectId: imp.projectId, employeeId: imp.employeeId, data: { improvementId: id, kind: imp.kind, action: a.type, ...(auto ? { by: actor, quiet: true } : {}) } });
    return imp;
  }

  dismiss(id: string, actor = 'owner'): Improvement {
    const imp = this.core.improvements.require(id);
    if (imp.status !== 'proposed') throw new EngineError(`this suggestion was already ${imp.status}`, 409);
    imp.status = 'dismissed';
    imp.decidedAt = nowIso();
    this.core.put('improvement', imp);
    this.core.audit(actor, 'improvement.dismissed', id, { kind: imp.kind });
    this.core.event({ type: 'improvement.dismissed', source: 'owner', summary: `Dismissed: ${imp.title}`, projectId: imp.projectId, employeeId: imp.employeeId, data: { improvementId: id, kind: imp.kind, quiet: true } });
    return imp;
  }
}
