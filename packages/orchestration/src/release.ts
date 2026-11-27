import { nowIso, redactSecrets, releaseRulesOf, truncate, type Employee, type Project, type ReleaseRules, type Task } from '@orchestrator/contracts';
import { EngineError, type Core } from './core.ts';
import type { Engine } from './engine.ts';

/**
 * The release gate (`docs/RELEASE-GATE.md`; the owner, 2026-11-23: "review must be the gate — I see what they did, and
 * if it is good I let it go on to where it has to go"). Employees work and try things freely: their own branches, a
 * development server. What would reach a protected branch (`master`, `main`) or a production server is held by their
 * machine (`releaseOf`, `LaunchSpec.release`) and decided here, at once: it goes through only for somebody an owner
 * let release — by approving a ticket they worked on (for a few hours, until they report it out), or by hand.
 *
 * Who may release now is kept in the office's key-value store (`release.passes`), so a restart keeps it.
 */
const KV = 'release.passes';
/** How long an approval keeps the gate open for those who release the work. */
export const RELEASE_OPEN_MS = 3 * 3600_000;

export interface ReleasePass {
  employeeId: string;
  /** The ticket it is for (null: let through by hand). */
  taskId: string | null;
  until: string;
  by: string;
  at: string;
}

export class Release {
  private readonly core: Core;
  private readonly eng: Engine;
  constructor(eng: Engine) {
    this.eng = eng;
    this.core = eng.core;
  }

  rules(): ReleaseRules {
    return releaseRulesOf(this.core.settings);
  }

  on(): boolean {
    return this.rules().on;
  }

  /** The rules a session of this employee is started with (none while rented: a client's work has its own terms). */
  rulesFor(employee: Employee): ReleaseRules | null {
    const r = this.rules();
    return r.on && !this.eng.rent.isRented(employee.id) ? r : null;
  }

  passes(): ReleasePass[] {
    const now = new Date().toISOString();
    return this.core.store.kvGet<ReleasePass[]>(KV, []).filter((p) => p.until > now);
  }

  private save(list: ReleasePass[]): void {
    const now = new Date().toISOString();
    this.core.store.kvSet(KV, list.filter((p) => p.until > now));
  }

  /** Until when this employee may release (null: they may not now). */
  openUntil(employeeId: string): string | null {
    const mine = this.passes().filter((p) => p.employeeId === employeeId);
    return mine.length ? mine.map((p) => p.until).sort().at(-1)! : null;
  }

  /**
   * A command their machine held as a release: let through, or refused with what to do instead. Written down either
   * way; a refusal is told in the feed.
   */
  decide(employee: Employee | null, what: string, why: string): { allow: boolean; reason: string } {
    if (!employee) return { allow: false, reason: `Orchestrator release gate: ${why}. Only an employee whose work an owner approved releases.` };
    const until = this.openUntil(employee.id);
    if (until) {
      const pass = this.passes().find((p) => p.employeeId === employee.id && p.until === until)!;
      const task = pass.taskId ? this.core.tasks.get(pass.taskId) : undefined;
      this.core.audit('office', 'release.allowed', employee.id, { employee: employee.name, why, what: truncate(what, 300), task: task?.key ?? null });
      return { allow: true, reason: `Release gate: open for ${employee.name} until ${until.slice(11, 16)} UTC (${task ? `${task.key} was approved` : 'let through by an owner'}).` };
    }
    // (The record keeps the whole command, secrets hidden — owners only: whether the gate erred cannot be told from its
    // first 300 characters, which is all the feed line carries. 2026-11-27: a refused read could not be judged.)
    this.core.audit('office', 'release.held', employee.id, { employee: employee.name, why, what: truncate(redactSecrets(what), 4000) });
    this.core.event({ type: 'release.held', source: 'server', summary: `${employee.name} tried to release work before it was approved (${why}): refused`, employeeId: employee.id, data: { why, what: truncate(what, 300) } });
    const task = this.eng.tasks.currentTask(employee.id);
    const next = task
      ? task.status === 'REVIEW'
        ? `${task.key} is in review: wait for an owner's approval — you are told when it comes, and then this goes through.`
        : `Finish ${task.key}, commit, and hand it in with complete_task — say in release_plan where it goes and how (branches, servers, steps). When an owner approves it you are told, and then this goes through.`
      : 'Release only work an owner approved: hand the work in on its ticket with complete_task and a release_plan.';
    const ask = 'If it cannot wait for a ticket, or the boss already said yes in words: ask_boss with kind "deployment" — what goes where — and mark the choice that lets you release with release: true. When an owner picks it, this goes through for an hour.';
    // What is free instead, for what was refused (seen on the live office: the employee went on at once when it knew).
    const instead = /cannot be read here/.test(why)
      ? 'If what you send there only reads, put it in the command itself (a heredoc to ssh) so the office can read it: reading production is free.'
      : /production server/.test(why)
        ? 'Reading production is free, and so are probes written into /tmp there; anything else you change there waits for the approval. A development server is free.'
        : '';
    return {
      allow: false,
      reason: `Orchestrator release gate: this command releases work (${why}). Nothing goes to ${this.rules().branches.join(' / ')} or to production before an owner approved it; your own branches and the development servers are free. ${instead ? `${instead} ` : ''}${next} ${task?.status === 'REVIEW' ? '' : `${ask} `}Do not try it another way.`,
    };
  }

  /**
   * An owner approved a ticket: those who release it may, for a few hours — its author, and the colleagues who worked on
   * it with them (wrote on it, were asked on it, share it) — and they are told so, with the plan the author handed in.
   */
  approved(task: Task, by: string): void {
    if (!this.on()) return;
    const authorId = task.authorId ?? task.assigneeId;
    if (!authorId) return;
    const helpers = new Set<string>();
    for (const c of task.comments ?? []) {
      if (c.from.kind === 'employee' && c.from.id) helpers.add(c.from.id);
      for (const m of c.mentions ?? []) if (m.kind === 'employee') helpers.add(m.id);
    }
    for (const id of task.helperIds ?? []) helpers.add(id);
    // The reviewers judged the work; releasing it is not theirs.
    helpers.delete(authorId);
    if (task.evidence.peerReview?.reviewerId) helpers.delete(task.evidence.peerReview.reviewerId);
    for (const r of this.core.tasks.filter((t) => t.reviewOf === task.id)) if (r.assigneeId) helpers.delete(r.assigneeId);
    // Whoever the approved plan names does that part (it says who does which): "then Ops pulls on production". They were
    // left out unless they had written on the ticket, and a ticket only to release followed, for a second approval.
    const planned = task.release?.plan ?? '';
    if (planned) {
      const named = (name: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(planned);
      for (const e of this.core.employees.filter((x) => !x.archived && x.id !== authorId && named(x.name))) helpers.add(e.id);
    }
    const until = new Date(Date.now() + RELEASE_OPEN_MS).toISOString();
    const holders = [authorId, ...[...helpers].filter((id) => {
      const e = this.core.employees.get(id);
      return !!e && !e.archived && !this.eng.rent.isRented(id);
    })];
    const list = this.passes().filter((p) => p.taskId !== task.id);
    for (const id of holders) list.push({ employeeId: id, taskId: task.id, until, by, at: nowIso() });
    this.save(list);
    task.release = { ...(task.release ?? { plan: null }), approvedAt: nowIso(), approvedBy: by, openUntil: until, releasedAt: null, releasedBy: null, note: null };
    this.core.put('task', task);
    this.core.audit(by, 'release.opened', task.id, { key: task.key, holders: holders.map((id) => this.core.employees.get(id)?.name ?? id), until });
    const author = this.core.employees.get(authorId);
    const plan = task.release.plan?.trim();
    const hours = Math.round(RELEASE_OPEN_MS / 3600_000);
    if (author)
      this.eng.comms.sendMessage({
        from: { kind: 'system', id: null, name: 'the office' },
        toEmployeeId: author.id,
        kind: 'system',
        taskId: task.id,
        body: `${by} approved ${task.key} "${truncate(task.title, 100)}". Release it now${plan ? `, as you planned:\n${plan}\n` : ' — where it has to go (you handed in no release plan: do what the ticket asks, nothing more).'}\nPushes to ${this.rules().branches.join(' / ')} and changes on production are open for you for ${hours} hours.${holders.length > 1 ? ` ${holders.slice(1).map((id) => this.core.employees.get(id)?.name).filter(Boolean).join(', ')} may help you with it in that time.` : ''} When it is out, call report_released with task "${task.key}" and what you did and checked.`,
      });
    for (const id of holders.slice(1))
      this.eng.comms.sendMessage({
        from: { kind: 'system', id: null, name: 'the office' },
        toEmployeeId: id,
        kind: 'system',
        taskId: task.id,
        body: `${by} approved ${task.key} "${truncate(task.title, 100)}" (${author?.name ?? 'its author'} releases it). If they ask you to do part of the release — production, a push — you may, for ${hours} hours. Nothing else is released on this.`,
      });
    this.core.event({ type: 'release.opened', source: 'owner', summary: `${task.key} approved: ${holders.map((id) => this.core.employees.get(id)?.name ?? id).join(', ')} may release it until ${until.slice(11, 16)} UTC`, taskId: task.id, projectId: task.projectId, employeeId: authorId, data: { key: task.key, until, holders } });
  }

  /** An owner lets one employee release, by hand, for a while (a fix that cannot wait for a ticket). */
  grant(employeeId: string, minutes: number, by: string): { until: string } {
    const e = this.core.employees.require(employeeId);
    const m = Math.max(5, Math.min(24 * 60, Math.round(minutes) || 60));
    const until = new Date(Date.now() + m * 60_000).toISOString();
    this.save([...this.passes(), { employeeId: e.id, taskId: null, until, by, at: nowIso() }]);
    this.core.audit(by, 'release.granted', e.id, { employee: e.name, minutes: m });
    this.core.event({ type: 'release.opened', source: 'owner', summary: `${by} let ${e.name} release for ${m} minutes`, employeeId: e.id, data: { until, minutes: m } });
    return { until };
  }

  /** The gate closes again for this employee (an owner's word), or for one ticket's release. */
  close(opts: { employeeId?: string; taskId?: string }, by: string): void {
    const left = this.passes().filter((p) => !(opts.employeeId && p.employeeId === opts.employeeId) && !(opts.taskId && p.taskId === opts.taskId));
    this.save(left);
    this.core.audit(by, 'release.closed', opts.employeeId ?? opts.taskId ?? '', opts);
  }

  /** The author says the work is out: written on the ticket, and the gate closes for it. */
  reported(employee: Employee, taskRef: string, note: string): string {
    const task = this.eng.tasks.taskByKey(taskRef, null) ?? this.core.tasks.get(taskRef);
    if (!task) throw new EngineError(`no task "${taskRef}"`);
    // Let out on an owner's word — a pass by hand, or their yes to a question about it — not by approving the ticket: that
    // is its approval (it was refused here, and the release went unrecorded).
    const byHand = !task.release?.approvedAt ? this.passes().filter((p) => p.employeeId === employee.id && !p.taskId).sort((a, b) => (a.at < b.at ? 1 : -1))[0] : undefined;
    if (byHand) task.release = { plan: task.release?.plan ?? null, ...task.release, approvedAt: byHand.at, approvedBy: byHand.by, openUntil: byHand.until, releasedAt: null, releasedBy: null, note: null };
    if (!task.release?.approvedAt) throw new EngineError(`${task.key} was not approved for release`);
    if (task.release.releasedAt) return `${task.key} was already reported released (${task.release.releasedAt.slice(0, 16)}).`;
    const words = note.trim();
    if (words.length < 12) throw new EngineError('say what you released and how you checked it (a sentence at least)');
    task.release = { ...task.release, releasedAt: nowIso(), releasedBy: employee.name, note: words };
    this.core.put('task', task);
    this.eng.talk.add(task, { from: { kind: 'employee', id: employee.id, name: employee.name }, body: `Released.\n\n${words}`, kind: 'note', mentions: [] }, { store: true, quiet: true });
    this.close({ taskId: task.id }, `employee:${employee.name}`);
    if (byHand) this.close({ employeeId: employee.id }, `employee:${employee.name}`);
    this.core.event({ type: 'task.released', source: 'mcp', summary: `${employee.name} released ${task.key}`, taskId: task.id, projectId: task.projectId, employeeId: employee.id, data: { key: task.key, note: truncate(words, 600) } });
    return `${task.key} is recorded as released. The gate is closed again for it.`;
  }

  /** The gate is on and this project gives each employee a branch of their own: they push it, and release approved work. */
  branchPush(employee: Employee, project: Project | undefined | null): boolean {
    return !!this.rulesFor(employee) && project?.workspace === 'worktrees';
  }

  /**
   * In a project of worktrees, with the gate on (the owner, 2026-11-23: try on the development server from the task's
   * branch; the author moves master as the approved plan says): how this task is tried and released.
   */
  branchRelease(employee: Employee, task: Task, project: Project): string {
    if (!this.branchPush(employee, project) || !task.branch) return '';
    const base = project.baseBranch;
    const integration = project.integrationBranch;
    const repo = task.repoRoot ?? project.repoPath ?? 'the repository';
    return [
      `How this task is tried and released (this project gives you a branch of your own):`,
      `- To try it on the development server: \`git push origin ${task.branch}\`, and check that branch out there (free). Push no other branch.`,
      `- When an owner approves it, the office merges it into ${integration}. Then release it as your plan says — and write these steps into release_plan: in ${repo} (on ${base}) \`git merge --ff-only ${integration}\` and \`git push origin ${base}\`; put the development server back on ${base} and pull it there, then on production; check; call report_released.`,
    ].join('\n');
  }

  /** What an employee is told about the gate, in their standing instructions and with every task (empty while it is off). */
  instructions(employee: Employee): string {
    const r = this.rulesFor(employee);
    if (!r) return '';
    return [
      `The release gate of this office: nothing reaches ${r.branches.join(' / ')}${r.hosts.length ? ` or the production servers (${r.hosts.join(', ')})` : ' or production'} before an owner has approved the work.`,
      'Before that, work and try freely: commit, push your own branches, put it on the development servers. A push to a protected branch, merging a pull request, or a change on a production server is refused by the office until then.',
      'Where a development server follows a protected branch (it pulls master), try your work there from your own branch instead: push your branch and check it out on the development server — that is free — and put the development server back on the protected branch once it is released.',
      'Hand the work in with complete_task and give release_plan: where it goes once approved and how — branches, servers, steps, checks, and who does which part (whoever it names by name may do that part once it is approved). The owner reads it in review. When an owner approves it you are told, and the release is open for you (and the colleagues on the ticket) for a few hours: do what the plan says, then call report_released with what you did and how you checked it.',
      'Do not open a separate ticket only to release work that is handed in or approved: its release is the release_plan of the ticket whose work it is, and goes out when that ticket is approved.',
    ].join(' ');
  }

  /** What the gate refused lately, newest first: who, why, the command (for an owner to see whether it errs). */
  recentHeld(limit = 10): Array<{ ts: string; employeeId: string | null; employee: string; why: string; what: string }> {
    return this.core.store.queryEvents({ types: ['release.held'], limit: Math.max(1, Math.min(50, limit)) }).reverse().slice(0, limit).map((e) => ({
      ts: e.ts,
      employeeId: e.employeeId,
      employee: this.core.employees.get(e.employeeId ?? '')?.name ?? 'an employee',
      why: String(e.data?.why ?? ''),
      what: String(e.data?.what ?? ''),
    }));
  }

  /** The rules changed: every running session has them from its next command (machines that know the gate). */
  push(): void {
    for (const s of this.core.sessions.filter((x) => x.status === 'running' || x.status === 'starting')) {
      const e = this.core.employees.get(s.employeeId);
      const host = this.core.hosts.get(s.hostId);
      if (!e || !host?.info?.releaseGate || !this.core.agents.isOnline(s.hostId)) continue;
      void this.core.agents.rpc(s.hostId, { method: 'session.release', params: { sessionId: s.id, release: this.rulesFor(e) } }, 8000).catch((err) => this.core.log('warn', `the release gate did not reach ${e.name}'s session: ${(err as Error).message}`));
    }
  }
}
