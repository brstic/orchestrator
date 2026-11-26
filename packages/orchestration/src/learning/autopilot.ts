import type { AutonomyLevel, AutopilotMode, AutopilotUndo, Employee, EvidenceRef, Improvement, ImprovementAction, ImprovementKind, OrchestratorEvent, Project, Question, Task } from '@orchestrator/contracts';
import { AUTONOMY_LEVELS, isAutonomyLevel, nowIso, truncate } from '@orchestrator/contracts';
import { EngineError } from '../core.ts';
import type { Engine } from '../engine.ts';
import { DEFAULT_HIGH_RISK_PATTERNS } from '../prompts.ts';
import { revertDetectAction } from './detect.ts';

/**
 * The autopilot: the office applies what it has learned by itself, where that is safe, and takes it
 * back when it was wrong.
 *
 * `Improver.analyze()` proposes; this module decides which proposals need no click. One dial
 * (`settings.selfImprovement.autopilot`) says how far it may go:
 *
 *   off      nothing is applied without a person.
 *   safe     only changes that cannot widen what agents may do without asking.
 *   trusted  also widening changes, each under an evidence rule defined below, each on probation.
 *
 * Everything it does goes through `Improver.apply` — the same path as the owner's click — under the
 * actor name `autopilot`, is recorded as a `learning.*` event with its evidence and how to undo it,
 * and can be reversed (`revert`). It reads the office's own records only: no model, no prompt, no
 * Claude usage. It never answers a permission request.
 */

export const AUTOPILOT_AREA = 'autopilot';
/** The name automatic changes carry in the audit log and on the improvement. */
export const AUTOPILOT_ACTOR = 'autopilot';

const rank = (level: AutonomyLevel | undefined): number => (level ? AUTONOMY_LEVELS.indexOf(level) : -1);

/** Denials of one command shape (and no approval) a deny rule rests on: the analyser's own threshold, checked again when applying. */
export const AUTOPILOT_DENIALS_FOR_DENY_RULE = 3;

/** What the table needs to know about the office as it is now. */
export interface AutopilotLook {
  project(id: string): Pick<Project, 'verifyTimeoutSec'> | undefined;
  employee(id: string): Pick<Employee, 'autonomy'> | undefined;
}

type ActionType = ImprovementAction['type'];
type Judgement = { widening: boolean; why: string };

/**
 * The one table. Every kind of proposal lists the actions it may carry, and every action says
 * whether it widens what agents may do without asking. A kind or an action that is not here, or an
 * action its kind is not expected to carry, counts as widening (`classify`).
 *
 * "Widening" is about permission to act unasked: more pre-approved commands, a higher autonomy
 * level, less review. A change in the other direction, or one that touches no permission, is not.
 * Where direction matters and cannot be told (an unknown employee, an equal level, a timeout that
 * is not longer), the answer is "widening".
 */
export const AUTOPILOT_TABLE: {
  kinds: Record<ImprovementKind, ActionType[]>;
  actions: { [T in ActionType]: (action: Extract<ImprovementAction, { type: T }>, now: AutopilotLook) => Judgement };
} = {
  kinds: {
    allow_rule: ['project.policy.allow'],
    deny_rule: ['project.policy.deny'],
    autonomy: ['employee.autonomy'],
    review_policy: ['project.requireReview'],
    verify_command: ['advice'],
    verify_timeout: ['project.verifyTimeout'],
    sequencing: ['advice'],
    acceptance_criteria: ['advice'],
    routing: ['advice', 'project.routing'],
    // Advice from the other parts of Growth: a person reads it and decides; the office never applies advice by itself.
    playbook_contradiction: ['advice'],
    revert_improvement: ['advice'],
    // Found by the detectors (learning/detect.ts). Three of them can carry a change of their own; none of it is a permission.
    task_size: ['advice'],
    dependencies: ['advice', 'task.dependsOn'],
    missing_context: ['project.notes.append'],
    stall: ['advice'],
    verify_quality: ['advice'],
    machine_load: ['advice'],
    idle_capacity: ['advice'],
  },
  actions: {
    'task.dependsOn': () => ({ widening: false, why: 'it only makes one task wait for another' }),
    'project.routing': () => ({ widening: false, why: 'it only changes who is preferred for a kind of task' }),
    'project.notes.append': () => ({ widening: false, why: 'it adds a sentence to what the project tells its employees; it permits nothing' }),
    'project.policy.allow': () => ({ widening: true, why: 'an allow rule lets matching commands run without asking' }),
    'project.policy.deny': () => ({ widening: false, why: 'a deny rule only takes away' }),
    'project.requireReview': (a) => (a.value === true ? { widening: false, why: 'requiring review adds a check' } : { widening: true, why: 'switching review off removes a check' }),
    'project.verifyTimeout': (a, now) => {
      const current = now.project(a.projectId)?.verifyTimeoutSec;
      return typeof current === 'number' && a.seconds > current ? { widening: false, why: 'a longer verification timeout touches no permission' } : { widening: true, why: 'only a longer verification timeout is known to be harmless' };
    },
    'employee.autonomy': (a, now) => {
      const from = rank(now.employee(a.employeeId)?.autonomy);
      const to = rank(a.level);
      return from >= 0 && to >= 0 && to < from ? { widening: false, why: 'a lower autonomy level only takes away' } : { widening: true, why: 'a higher (or not clearly lower) autonomy level lets the employee do more unasked' };
    },
    advice: () => ({ widening: false, why: 'advice changes nothing' }),
  },
};

/** Widening or not, from the table. `known` is false when the kind, the action or their pairing is not in it. */
export function classify(imp: Pick<Improvement, 'kind' | 'action'>, now: AutopilotLook): Judgement & { known: boolean } {
  const type = String((imp.action as { type?: unknown } | null | undefined)?.type ?? '');
  const expected = Object.hasOwn(AUTOPILOT_TABLE.kinds, imp.kind) ? AUTOPILOT_TABLE.kinds[imp.kind] : undefined;
  const judge = Object.hasOwn(AUTOPILOT_TABLE.actions, type) ? (AUTOPILOT_TABLE.actions as Record<string, (a: any, now: AutopilotLook) => Judgement>)[type] : undefined;
  if (!expected || !judge) return { widening: true, known: false, why: `"${imp.kind}" / "${type}" is not in the autopilot's table, so it counts as widening` };
  if (!expected.includes(type as ActionType)) return { widening: true, known: false, why: `a "${imp.kind}" suggestion is not expected to carry the action "${type}", so it counts as widening` };
  return { ...judge(imp.action, now), known: true };
}

// ───────────────────────── command shapes ─────────────────────────

/**
 * The first one or two words of a shell command: what an allow or deny rule is written for.
 * The same reading as `Improver.commandShape`, which names the rules. If the two ever disagree the
 * shapes stop matching and nothing is applied: it fails closed.
 */
export function commandShape(command: string): string | null {
  const first = (command.split(/&&|\|\||;|\|/)[0] ?? '').trim();
  const words = first.split(/\s+/).filter(Boolean);
  if (!words.length || /[`$(){}<>]/.test(words.slice(0, 2).join(' '))) return null;
  // A program named by its path (`/bin/bash`, `./run.sh`, `~/bin/x`) is no shape to write a rule for: the block
  // list below knows words, and a path to the same program is not one of them.
  if (/[\/~\\]/.test(words[0]!)) return null;
  // Nor a variable set before the command (`S=/tmp/…; curl …`, `FOO=1 npm test`): not a program at all.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return null;
  const two = ['npm', 'pnpm', 'yarn', 'git', 'docker', 'cargo', 'go', 'make', 'npx', 'python', 'python3', 'php', 'composer', 'kubectl', 'pip', 'bundle'].includes(words[0]!) && words[1] && !words[1].startsWith('-');
  return two ? `${words[0]} ${words[1]}` : words[0]!;
}

const commandOf = (q: Question): string => String((q.tool?.input as { command?: unknown } | null | undefined)?.command ?? '');
/** `Bash(docker build:*)` → `docker build`; anything else is not a command-shape rule. */
const shapeOfRule = (rule: string): string | null => /^Bash\(([^()]+):\*\)$/.exec(rule)?.[1]?.trim() || null;
const PLAIN_SHAPE = /^[A-Za-z0-9._\/@+-]+( [A-Za-z0-9._\/@:+-]+)?$/;
/** Does any part of a (possibly chained) command begin with this shape? Used for counter-evidence, so it is generous. */
const touchesShape = (command: string, shape: string): boolean =>
  command
    .trim()
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim())
    .some((part) => part === shape || part.startsWith(`${shape} `));

/**
 * Commands that run other commands or reach anywhere: a rule for one of these words alone would
 * pre-approve far more than was ever observed, so the office never adds it by itself.
 * A block list is not proof of safety — the high-risk gate stays in front of every session regardless.
 */
const NEVER_ALLOW_ALONE = new Set(
  'sh bash zsh fish dash ksh env xargs eval exec source sudo su doas ssh scp sftp rsync nohup time timeout watch nice rm mv cp dd chmod chown chgrp kill curl wget nc ncat telnet node deno bun ruby perl python python3 php osascript npx git npm pnpm yarn docker kubectl helm terraform make cargo go pip pip3 composer bundle find awk sed tee open command builtin bunx pnpx uvx pipx gh glab just task tsx ts-node bash3 busybox script expect parallel'.split(' '),
);
/** Shapes whose next argument names what to run (a script, a package, a container): as wide as the word alone. */
const NEVER_ALLOW_SHAPES = new Set(
  ['npm run', 'npm exec', 'npm x', 'npm start', 'pnpm run', 'pnpm exec', 'pnpm dlx', 'pnpm start', 'yarn run', 'yarn exec', 'yarn dlx', 'yarn start', 'docker run', 'docker exec', 'docker compose', 'kubectl exec', 'kubectl run', 'go run', 'cargo run', 'bundle exec', 'composer run', 'composer exec', 'composer run-script', 'git config'],
);
/** Tools an employee cannot work without: denying one of these words alone would stop the work, so that waits for a person. */
const NEVER_DENY_ALONE = new Set('sh bash zsh cd ls cat echo pwd rm mv cp mkdir touch grep find sed awk head tail git npm pnpm yarn npx node python python3 make cargo go docker pip composer bundle php'.split(' '));

type Verdict = { apply: true; widening: boolean; why: string; evidence: EvidenceRef[] } | { apply: false; widening: boolean; why: string };

export class Autopilot {
  private eng: Engine;

  constructor(eng: Engine) {
    this.eng = eng;
    // Counter-signals are read from the office's own event stream: nothing else has to call in.
    eng.core.bus.on('event', (e) => this.guard(() => this.onEvent(e)));
    eng.core.bus.on('entity', (kind, op, data) => {
      if (kind === 'question' && op === 'upsert') this.guard(() => this.onQuestion(data as Question));
    });
  }

  private get core() {
    return this.eng.core;
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.core.log('warn', `autopilot: ${(e as Error).message}`);
    }
  }

  /** The dial. Off whenever self-improvement as a whole is off. */
  get mode(): AutopilotMode {
    const si = this.core.settings.selfImprovement;
    return si.enabled ? si.autopilot : 'off';
  }

  private get look(): AutopilotLook {
    return { project: (id) => this.core.projects.get(id), employee: (id) => this.core.employees.get(id) };
  }

  // ───────────────────── bookkeeping around apply ────────────────────

  /** Before `Improver.apply` changes anything: what is there now, so the change can be undone exactly. */
  before(imp: Improvement): { undo: AutopilotUndo | null; widening: boolean } {
    const a = imp.action;
    const widening = classify(imp, this.look).widening;
    const project = 'projectId' in a ? this.core.projects.get(a.projectId) : undefined;
    switch (a.type) {
      case 'project.policy.allow':
        return { widening, undo: project ? { type: a.type, projectId: a.projectId, rule: a.rule, added: !project.policy.allow.includes(a.rule) } : null };
      case 'project.policy.deny':
        return { widening, undo: project ? { type: a.type, projectId: a.projectId, rule: a.rule, added: !project.policy.deny.includes(a.rule) } : null };
      case 'project.requireReview':
        return { widening, undo: project ? { type: a.type, projectId: a.projectId, previous: project.policy.requireReview, applied: a.value } : null };
      case 'project.verifyTimeout':
        return { widening, undo: project ? { type: a.type, projectId: a.projectId, previous: project.verifyTimeoutSec, applied: a.seconds } : null };
      case 'employee.autonomy': {
        const e = this.core.employees.get(a.employeeId);
        return { widening, undo: e ? { type: a.type, employeeId: a.employeeId, previous: e.autonomy, applied: a.level } : null };
      }
      case 'advice':
        return { widening, undo: { type: 'advice' } };
      case 'task.dependsOn':
      case 'project.routing':
      case 'project.notes.append':
        // What was there before is written on the improvement by the action itself (`previous`).
        return { widening, undo: { type: 'detect' } };
      default:
        return { widening: true, undo: null };
    }
  }

  /** After `Improver.apply` made the change: who did it, how to undo it and, for the office's own changes, the probation. */
  after(imp: Improvement, ticket: { undo: AutopilotUndo | null; widening: boolean }, actor: string): void {
    const auto = actor === AUTOPILOT_ACTOR;
    const now = nowIso();
    const t = this.core.timings;
    imp.autopilot = {
      appliedBy: actor,
      auto,
      appliedAt: now,
      widening: ticket.widening,
      undo: ticket.undo,
      probation: auto ? { startedAt: now, until: new Date(Date.now() + t.autopilotProbationMs).toISOString(), tasksLeft: Math.max(1, t.autopilotProbationTasks), taskIds: [], status: 'running' } : null,
      reverted: null,
      noAuto: imp.autopilot?.noAuto ?? false,
      history: [...(imp.autopilot?.history ?? []), { ts: now, what: 'applied', by: actor, note: auto ? 'Applied by the office itself' : 'Applied by a person' }],
    };
  }

  // ───────────────────────────── deciding ────────────────────────────

  /**
   * The member whose own computer a host is, and how the audit log names their decisions
   * (`member:<name>`, the name the host was enrolled under); null for a shared machine.
   */
  private personal(hostId: string | null | undefined): { memberId: string; actor: string | null } | null {
    const host = hostId ? this.core.hosts.get(hostId) : undefined;
    if (!host?.memberId) return null;
    return { memberId: host.memberId, actor: host.memberName ? `member:${host.memberName}` : null };
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

  /** Every Bash permission request ever made in a project. */
  private asked(projectId: string): Question[] {
    return this.core.questions.filter((q) => q.kind === 'permission' && q.projectId === projectId && q.tool?.name === 'Bash');
  }

  /**
   * Would the autopilot apply this proposal now, and why (not)? Reads the record as it is at this
   * moment, not as it was when the proposal was made.
   */
  verdict(imp: Improvement): Verdict {
    const cls = classify(imp, this.look);
    const no = (why: string): Verdict => ({ apply: false, widening: cls.widening, why });
    const mode = this.mode;
    if (mode === 'off') return no('The autopilot is off: every suggestion waits for a person.');
    if (imp.status !== 'proposed') return no(`It is already ${imp.status}.`);
    if (imp.autopilot?.noAuto) return no('It was taken back once, so it is not applied again without a person.');
    const a = imp.action;
    if (cls.known && a.type === 'advice') return no('Advice has nothing the office could apply: it is for a person to read and act on.');

    const project = 'projectId' in a ? this.core.projects.get(a.projectId) : undefined;
    const employee = 'employeeId' in a ? this.core.employees.get(a.employeeId) : undefined;
    if (('projectId' in a && (!project || project.status === 'archived')) || ('employeeId' in a && (!employee || employee.archived))) return no('What it would change no longer exists.');
    if (employee?.roleKey === 'foreman') return no('The foreman is changed by an owner only.');
    const personal = this.personal(project ? project.hostId : employee?.hostId);

    if (!cls.widening) {
      switch (a.type) {
        case 'project.policy.deny':
          return this.denyRule(a.rule, project!, personal, cls);
        case 'employee.autonomy':
          // Lowering autonomy rests on no decision of the member, so on their own computer it is theirs (or an owner's) to make.
          if (personal) return no("It changes permissions on a member's own computer, which the office does not do on its own evidence.");
          return { apply: true, widening: false, why: cls.why, evidence: imp.evidence };
        case 'project.verifyTimeout':
          return this.longerTimeout(a.seconds, project!, cls);
        case 'project.notes.append':
          // Every employee reads a project's notes as the project's own word, and this text is made of what
          // employees asked and were answered: it is put there by a person, not by the office on a count.
          return no("What goes into a project's notes is read by everybody as the project's own word; a person adds it.");
        default:
          return { apply: true, widening: false, why: cls.why, evidence: imp.evidence };
      }
    }

    if (mode !== 'trusted') return no(`It widens what employees may do without asking (${cls.why}); on "safe" that waits for you.`);
    if (!cls.known) return no(cls.why);
    switch (a.type) {
      case 'project.policy.allow':
        return this.allowRule(a.rule, project!, personal, cls);
      case 'employee.autonomy':
        // Above Standard there are Auto and Unrestricted, and each is a person's to give (the owner's, for
        // Unrestricted). Until 2026-11-13 the office could take somebody from Supervised to Standard on a clean
        // record; there is no level under Standard any more.
        return no('A higher level is a person\'s to give; the office never raises one by itself.');
      case 'project.requireReview':
        return this.reviewOff(project!, personal, cls);
      default:
        return no('No evidence rule exists for this kind of widening change, so it is never automatic.');
    }
  }

  /** safe: a deny rule, when the denials it rests on still stand. */
  private denyRule(rule: string, project: Project, personal: { actor: string | null } | null, cls: Judgement): Verdict {
    const no = (why: string): Verdict => ({ apply: false, widening: cls.widening, why });
    const shape = shapeOfRule(rule);
    if (!shape || !PLAIN_SHAPE.test(shape)) return no('Only a rule for one command shape, such as Bash(wget:*), is added automatically.');
    if (!shape.includes(' ') && NEVER_DENY_ALONE.has(shape)) return no(`Blocking every "${shape}" command would stop the work itself; that is for a person to decide.`);
    const asked = this.asked(project.id).filter((q) => commandShape(commandOf(q)) === shape);
    if (asked.some((q) => q.decision === 'allow')) return no(`A "${shape}" command has been approved in ${project.name} since, so the record no longer says "always no".`);
    // On a member's own computer only that member's own denials count.
    const denied = asked.filter((q) => q.decision === 'deny' && (!personal || (!!personal.actor && q.autopilotDecidedBy === personal.actor)));
    if (denied.length < AUTOPILOT_DENIALS_FOR_DENY_RULE) return no(personal ? `It is on a member's own computer, and fewer than ${AUTOPILOT_DENIALS_FOR_DENY_RULE} of the denials are that member's own.` : `Fewer than ${AUTOPILOT_DENIALS_FOR_DENY_RULE} denials of "${shape}" are on record.`);
    return { apply: true, widening: false, why: `${denied.length} "${shape}" commands were denied in ${project.name} and none approved; ${cls.why}.`, evidence: denied.slice(-12).map((q) => ({ kind: 'approval' as const, id: q.id, note: truncate(commandOf(q), 100) })) };
  }

  /**
   * safe: a longer verification timeout — when verifications have timed out since it was last raised.
   * The analyser counts every timeout on record, so without this check each new reading would double the
   * limit again on the same old evidence.
   */
  private longerTimeout(seconds: number, project: Project, cls: Judgement): Verdict {
    const no = (why: string): Verdict => ({ apply: false, widening: cls.widening, why });
    if (!(seconds <= 3600)) return no('More than an hour of verification is for a person to decide.');
    const lastRaise = this.core.improvements
      .filter((i) => i.status === 'applied' && i.action.type === 'project.verifyTimeout' && i.action.projectId === project.id)
      .map((i) => i.decidedAt ?? '')
      .sort()
      .pop();
    const timeouts = this.core.store.queryEvents({ projectId: project.id, types: ['task.verification_failed'], since: lastRaise || undefined, limit: 200 }).filter((e) => e.data.timedOut === true);
    if (timeouts.length < 2) return no(lastRaise ? 'No two verifications have timed out since the limit was last raised.' : 'Fewer than two verifications have timed out.');
    return { apply: true, widening: false, why: `Verification timed out ${timeouts.length} times at ${project.verifyTimeoutSec}s${lastRaise ? ' since the limit was last raised' : ''}; ${cls.why}.`, evidence: timeouts.slice(0, 6).map((e) => ({ kind: 'event' as const, id: e.id, note: e.summary })) };
  }

  /** trusted: an allow rule, under the strictest rule here. */
  private allowRule(rule: string, project: Project, personal: { actor: string | null } | null, cls: Judgement): Verdict {
    const no = (why: string): Verdict => ({ apply: false, widening: true, why });
    const t = this.core.timings;
    const shape = shapeOfRule(rule);
    if (!shape || !PLAIN_SHAPE.test(shape)) return no('Only a rule for one command shape, such as Bash(docker build:*), is ever added automatically.');
    if ((!shape.includes(' ') && NEVER_ALLOW_ALONE.has(shape)) || NEVER_ALLOW_SHAPES.has(shape)) return no(`A rule for every "${shape}" command would pre-approve far more than was observed.`);
    const asked = this.asked(project.id);
    const touching = asked.filter((q) => touchesShape(commandOf(q), shape));
    if (this.isHighRisk(shape, project) || touching.some((q) => this.isHighRisk(commandOf(q), project))) return no(`A "${shape}" command matches the high-risk list, which always comes to you.`);
    const denied = touching.filter((q) => q.decision === 'deny');
    if (denied.length) return no(`A "${shape}" command was denied in ${project.name} (${denied.length} time${denied.length === 1 ? '' : 's'}); one denial is enough.`);
    // The rule must be exactly as wide as what was approved: each approval counts only if it reads to this very shape.
    const approved = asked.filter((q) => q.decision === 'allow' && commandShape(commandOf(q)) === shape && (!personal || (!!personal.actor && q.autopilotDecidedBy === personal.actor))).sort((x, y) => (x.answeredAt ?? '').localeCompare(y.answeredAt ?? ''));
    const need = Math.max(1, t.autopilotAllowApprovals);
    if (approved.length < need) return no(personal ? `It is on a member's own computer: ${approved.length} of the ${need} approvals needed are that member's own.` : `${approved.length} of the ${need} approvals needed are on record.`);
    const tasks = new Set(approved.map((q) => q.taskId).filter(Boolean));
    const span = Date.parse(approved[approved.length - 1]!.answeredAt ?? '') - Date.parse(approved[0]!.answeredAt ?? '');
    if (tasks.size < 2 && !(span >= t.autopilotAllowSpreadMs)) return no('The approvals all come from one moment: they must span two tasks or at least the set time (a day by default).');
    return {
      apply: true,
      widening: true,
      why: `${approved.length} "${shape}" commands were approved in ${project.name}${tasks.size >= 2 ? ` across ${tasks.size} tasks` : ''}, none was ever denied, and none matches the high-risk list.`,
      evidence: approved.slice(-12).map((q) => ({ kind: 'approval' as const, id: q.id, note: truncate(commandOf(q), 100) })),
    };
  }

  /** trusted: review off, after a run of reviews that found nothing. Never on a member's own computer. */
  private reviewOff(project: Project, personal: unknown, cls: Judgement): Verdict {
    const no = (why: string): Verdict => ({ apply: false, widening: true, why });
    if (personal) return no("It is on a member's own computer; switching review off there is for that member or an owner.");
    const need = Math.max(1, this.core.timings.autopilotReviewOffTasks);
    const last = this.core.tasks
      .filter((x) => x.projectId === project.id && x.status === 'DONE' && x.kind !== 'review' && !!x.evidence.review)
      .sort((x, y) => (x.completedAt ?? '').localeCompare(y.completedAt ?? ''))
      .slice(-need);
    if (last.length < need) return no(`${last.length} of the ${need} reviewed tasks needed are on record.`);
    const sentBack = last.filter((x) => x.friction.reviewRejections > 0 || x.evidence.review?.verdict !== 'approved');
    if (sentBack.length) return no(`${sentBack.length} of the last ${need} reviewed tasks were sent back.`);
    return { apply: true, widening: true, why: `The last ${need} reviewed tasks in ${project.name} were all approved first time.`, evidence: last.slice(-12).map((x) => ({ kind: 'task' as const, id: x.id, note: `${x.key} ${x.title}` })) };
  }

  // ───────────────────────────── applying ────────────────────────────

  /** Whose daily allowance a change counts against. */
  private bucketOf(projectId: string | null | undefined, employeeId: string | null | undefined): string {
    return projectId ?? this.core.employees.get(employeeId)?.projectId ?? 'office';
  }

  private automaticEvents(sinceMs: number): OrchestratorEvent[] {
    return this.core.store.queryEvents({ types: ['learning.applied'], since: new Date(Date.now() - sinceMs).toISOString(), limit: 2000 }).filter((e) => e.data.area === AUTOPILOT_AREA && e.data.auto === true);
  }

  /** How many more automatic changes this project may get today. */
  allowance(bucket: string): number {
    const used = this.automaticEvents(86400_000).filter((e) => e.data.bucket === bucket).length;
    return Math.max(0, this.core.settings.selfImprovement.autopilotMaxPerDay - used);
  }

  /**
   * Apply what the dial allows. Called after every analysis; looks at every open proposal, not only
   * new ones, because evidence grows and the daily allowance refills. Returns what it applied.
   */
  run(): Improvement[] {
    this.sweep();
    if (this.mode === 'off') return [];
    const applied: Improvement[] = [];
    const open = this.core.improvements.filter((i) => i.status === 'proposed').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const imp of open) {
      let v: Verdict;
      let bucket: string;
      try {
        v = this.verdict(imp);
        if (!v.apply) continue;
        bucket = this.bucketOf(imp.projectId ?? ('projectId' in imp.action ? imp.action.projectId : null), imp.employeeId);
        if (this.allowance(bucket) <= 0) continue; // it stays proposed and is looked at again next time
        this.eng.improver.apply(imp.id, AUTOPILOT_ACTOR);
      } catch (e) {
        // One proposal that cannot be read or applied must not stop the others, nor the analysis that called us.
        this.core.log('warn', `autopilot could not apply "${imp.title}": ${(e as Error).message}`);
        continue;
      }
      const record = imp.autopilot!;
      record.history[record.history.length - 1]!.note = truncate(v.why, 300);
      this.core.put('improvement', imp);
      const probation = record.probation!;
      // The note that asked the owner to decide is settled; the new one is for the record, not a request.
      this.eng.comms.resolveNotifications((n) => n.kind === 'improvement' && n.title === `Suggestion: ${imp.title}`);
      this.core.event({
        type: 'learning.applied',
        source: 'server',
        summary: `Applied by itself: ${imp.title}`,
        projectId: imp.projectId,
        employeeId: imp.employeeId,
        data: { auto: true, area: AUTOPILOT_AREA, what: imp.title, why: v.why, evidence: v.evidence, undo: { improvementId: imp.id, route: `POST /api/improvements/${imp.id}/revert`, restore: record.undo }, improvementId: imp.id, kind: imp.kind, widening: v.widening, bucket, probation: { until: probation.until, tasks: probation.tasksLeft } },
      });
      this.quietNote(`Applied by itself: ${imp.title}`, `${v.why} On probation until ${probation.until.slice(0, 10)} or ${probation.tasksLeft} finished task${probation.tasksLeft === 1 ? '' : 's'}${v.widening ? '; a denial or a failure in that time takes it back' : ''}. You can undo it under Growth.`, imp.projectId, imp.employeeId);
      applied.push(imp);
    }
    this.guard(() => this.activateOwnLessons());
    return applied;
  }

  /** A notification that is on the record but does not ask for anything: it is born resolved. */
  private quietNote(title: string, body: string, projectId: string | null, employeeId: string | null): void {
    const n = this.eng.comms.notify({ kind: 'improvement', severity: 'info', title, body, projectId, employeeId });
    n.resolvedAt = nowIso();
    this.core.put('notification', n);
  }

  /**
   * safe: a lesson that is scoped to one employee and still "proposed" is switched on — it reaches
   * that employee's prompts only. Lessons somebody else wrote about them, and the foreman's, wait.
   * Undo is the lesson's own switch (`PATCH /api/lessons/:id`); a lesson is switched on by itself once only.
   */
  private activateOwnLessons(): void {
    const waiting = this.core.lessons.filter((l) => l.status === 'proposed' && l.scope === 'employee' && !!l.employeeId);
    if (!waiting.length) return;
    const before = new Set(this.automaticEvents(365 * 86400_000).map((e) => e.data.lessonId).filter(Boolean));
    for (const l of waiting) {
      const e = this.core.employees.get(l.employeeId);
      if (!e || e.archived || e.roleKey === 'foreman' || before.has(l.id)) continue;
      if (l.authoredBy.kind === 'employee' && l.authoredBy.id !== l.employeeId) continue;
      const bucket = this.bucketOf(null, e.id);
      if (this.allowance(bucket) <= 0) continue;
      this.eng.improver.updateLesson(l.id, { status: 'active' }, AUTOPILOT_ACTOR);
      const why = `It is scoped to ${e.name} alone and was written by ${l.authoredBy.kind === 'employee' ? 'them' : l.authoredBy.kind === 'owner' ? 'an owner' : 'the office'}; a lesson gives no permission.`;
      this.core.event({
        type: 'learning.applied',
        source: 'server',
        summary: `Applied by itself: a lesson for ${e.name} is now active`,
        employeeId: e.id,
        data: { auto: true, area: AUTOPILOT_AREA, what: `Lesson for ${e.name}: ${truncate(l.text, 160)}`, why, evidence: l.evidence, undo: { lessonId: l.id, route: `PATCH /api/lessons/${l.id}`, restore: { status: 'proposed' } }, lessonId: l.id, widening: false, bucket },
      });
      this.quietNote(`Applied by itself: a lesson for ${e.name}`, `${truncate(l.text, 200)} — ${why} You can retire it under Growth.`, null, e.id);
    }
  }

  // ───────────────────────────── probation ───────────────────────────

  /** Changes the office made by itself that are still on trial. */
  onProbation(): Improvement[] {
    return this.core.improvements.filter((i) => i.status === 'applied' && !!i.autopilot?.auto && i.autopilot.probation?.status === 'running');
  }

  /** End the probations whose time is up. Checked whenever the autopilot wakes; there is no timer. */
  sweep(): void {
    const now = nowIso();
    for (const imp of this.onProbation()) if (imp.autopilot!.probation!.until <= now) this.keep(imp, 'the probation period ended without a counter-signal');
  }

  private keep(imp: Improvement, note: string): void {
    const record = imp.autopilot!;
    record.probation!.status = 'passed';
    record.history.push({ ts: nowIso(), what: 'kept', by: AUTOPILOT_ACTOR, note });
    this.core.put('improvement', imp);
    this.core.event({ type: 'learning.kept', source: 'server', summary: `Kept after probation: ${imp.title}`, projectId: imp.projectId, employeeId: imp.employeeId, data: { auto: true, area: AUTOPILOT_AREA, what: imp.title, why: note, evidence: record.probation!.taskIds.map((id) => ({ kind: 'task', id, note: this.core.tasks.get(id)?.key ?? '' })), undo: { improvementId: imp.id, route: `POST /api/improvements/${imp.id}/revert`, restore: record.undo }, improvementId: imp.id, quiet: true } });
  }

  /** A permission request appeared: a high-risk command of a shape that is on probation ends the trial at once. */
  private onQuestion(q: Question): void {
    if (q.kind !== 'permission' || q.status !== 'open' || q.tool?.name !== 'Bash' || !q.projectId) return;
    const command = commandOf(q);
    for (const imp of this.onProbation()) {
      const undo = imp.autopilot!.undo;
      if (undo?.type !== 'project.policy.allow' || undo.projectId !== q.projectId) continue;
      const shape = shapeOfRule(undo.rule);
      if (shape && touchesShape(command, shape) && this.isHighRisk(command, this.core.projects.get(q.projectId))) {
        this.rollback(imp.id, `A high-risk "${shape}" command was requested while the rule was on probation.`, [{ kind: 'approval', id: q.id, note: truncate(command, 100) }]);
      }
    }
  }

  private onEvent(e: OrchestratorEvent): void {
    switch (e.type) {
      case 'agent.permission_decided': {
        const q = this.core.questions.get(String(e.data.questionId ?? ''));
        if (!q || q.kind !== 'permission') return;
        // Who decided is in the audit entry written just before this event; keep it with the request, where evidence is counted.
        if (!q.autopilotDecidedBy) {
          const entry = this.core.store.recentAudit(12).find((x) => x.action === 'approval.decide' && x.target === q.id);
          if (entry) {
            q.autopilotDecidedBy = entry.actor;
            this.core.questions.put(q);
          }
        }
        if (q.decision !== 'deny') return;
        const command = q.tool?.name === 'Bash' ? commandOf(q) : '';
        for (const imp of this.onProbation()) {
          const undo = imp.autopilot!.undo;
          if (undo?.type === 'project.policy.allow' && undo.projectId === q.projectId) {
            const shape = shapeOfRule(undo.rule);
            if (shape && command && touchesShape(command, shape)) this.rollback(imp.id, `A "${shape}" command was denied while the rule was on probation.`, [{ kind: 'approval', id: q.id, note: truncate(command, 100) }]);
          }
        }
        return;
      }
      case 'task.verification_failed': {
        const output = `${String(e.data.command ?? '')}\n${String(e.data.outputTail ?? '')}`;
        for (const imp of this.onProbation()) {
          const undo = imp.autopilot!.undo;
          if (undo?.type === 'project.policy.allow' && undo.projectId === e.projectId) {
            // "Names it": the failure's own output contains the command shape. A plain text match, nothing cleverer.
            const shape = shapeOfRule(undo.rule);
            if (shape && output.includes(shape)) this.rollback(imp.id, `${String(e.data.key ?? 'A task')} failed verification and the output names "${shape}".`, [{ kind: 'event', id: e.id, note: e.summary }]);
          }
        }
        return;
      }
      case 'task.review_completed': {
        if (e.data.verdict !== 'changes_requested') return;
        const task = this.core.tasks.get(e.taskId);
        if (!task) return;
        for (const imp of this.onProbation()) {
          const undo = imp.autopilot!.undo;
          if (undo?.type === 'project.requireReview' && imp.autopilot!.widening && undo.projectId === task.projectId) this.rollback(imp.id, `${task.key} needed rework after review had been switched off.`, [{ kind: 'task', id: task.id, note: `${task.key} ${task.title}` }]);
        }
        return;
      }
      case 'project.integration_tested': {
        if (e.data.passed !== false) return;
        for (const imp of this.onProbation()) {
          const undo = imp.autopilot!.undo;
          if (undo?.type === 'project.requireReview' && imp.autopilot!.widening && undo.projectId === e.projectId) this.rollback(imp.id, 'The integration tests failed after a merge while review was switched off.', [{ kind: 'event', id: e.id, note: e.summary }]);
        }
        return;
      }
      case 'task.completed': {
        const task = this.core.tasks.get(e.taskId);
        if (task && task.kind !== 'review') this.count(task);
        this.sweep();
        return;
      }
    }
  }

  /** A finished task of the affected project or employee brings the end of a probation one step closer. */
  private count(task: Task): void {
    for (const imp of this.onProbation()) {
      const record = imp.autopilot!;
      const undo = record.undo;
      const mine = undo && 'projectId' in undo ? undo.projectId === task.projectId : undo && 'employeeId' in undo ? undo.employeeId === task.assigneeId : false;
      const p = record.probation!;
      if (!mine || p.taskIds.includes(task.id)) continue;
      p.taskIds.push(task.id);
      p.tasksLeft = Math.max(0, p.tasksLeft - 1);
      if (p.tasksLeft === 0) this.keep(imp, `${p.taskIds.length} tasks finished without a counter-signal`);
      else this.core.put('improvement', imp);
    }
  }

  // ───────────────────────────── undoing ─────────────────────────────

  /**
   * Put back what was there. Only what this change itself did is undone: a rule that was already
   * there stays, and a value a person has changed since is left as they set it.
   */
  private takeBack(undo: AutopilotUndo, actor: string): { restored: boolean; note: string } {
    switch (undo.type) {
      case 'project.policy.allow':
      case 'project.policy.deny': {
        const p = this.core.projects.get(undo.projectId);
        if (!p) return { restored: false, note: 'The project no longer exists.' };
        const allow = undo.type === 'project.policy.allow';
        const list = allow ? p.policy.allow : p.policy.deny;
        if (!undo.added) return { restored: false, note: `The rule ${undo.rule} was there before this was applied, so it stays.` };
        if (!list.includes(undo.rule)) return { restored: false, note: `The rule ${undo.rule} had already been removed.` };
        const without = list.filter((r) => r !== undo.rule);
        this.eng.tasks.updateProject(p.id, { policy: allow ? { allow: without } : { deny: without } }, actor);
        return { restored: true, note: `Removed the ${allow ? 'allow' : 'deny'} rule ${undo.rule} from ${p.name}. Sessions started from now on no longer have it.` };
      }
      case 'project.requireReview': {
        const p = this.core.projects.get(undo.projectId);
        if (!p) return { restored: false, note: 'The project no longer exists.' };
        if (p.policy.requireReview !== undo.applied) return { restored: false, note: 'Required review has been changed by hand since; it was left as it is.' };
        if (undo.previous === undo.applied) return { restored: false, note: 'It was already set that way before; nothing to put back.' };
        this.eng.tasks.updateProject(p.id, { policy: { requireReview: undo.previous } }, actor);
        return { restored: true, note: `Required review on ${p.name} is ${undo.previous ? 'on' : 'off'} again.` };
      }
      case 'project.verifyTimeout': {
        const p = this.core.projects.get(undo.projectId);
        if (!p) return { restored: false, note: 'The project no longer exists.' };
        if (p.verifyTimeoutSec !== undo.applied) return { restored: false, note: 'The verification timeout has been changed by hand since; it was left as it is.' };
        if (undo.previous === undo.applied) return { restored: false, note: 'It was already set that way before; nothing to put back.' };
        this.eng.tasks.updateProject(p.id, { verifyTimeoutSec: undo.previous }, actor);
        return { restored: true, note: `The verification timeout of ${p.name} is ${undo.previous}s again.` };
      }
      case 'employee.autonomy': {
        const e = this.core.employees.get(undo.employeeId);
        if (!e) return { restored: false, note: 'The employee no longer exists.' };
        if (e.autonomy !== undo.applied) return { restored: false, note: `${e.name}'s autonomy has been changed by hand since; it was left as it is.` };
        if (undo.previous === undo.applied) return { restored: false, note: 'It was already set that way before; nothing to put back.' };
        // A change made before 2026-11-13 may name a level that no longer exists (Restricted, Supervised, Autonomous).
        if (!isAutonomyLevel(undo.previous)) return { restored: false, note: `${e.name} was on a level that no longer exists ("${String(undo.previous)}"); it was left as it is.` };
        this.eng.employees.update(e.id, { autonomy: undo.previous }, actor);
        return { restored: true, note: `${e.name} is back on ${undo.previous}. It takes effect when their session is next started.` };
      }
      case 'advice':
        return { restored: false, note: 'Advice changed nothing, so there was nothing to put back.' };
      case 'detect':
        return { restored: false, note: 'This kind of change is taken back from its own record.' };
    }
  }

  /** How to reverse a change that was applied before the office kept undo records. Only what can be known exactly. */
  private undoWithoutRecord(a: ImprovementAction): AutopilotUndo {
    switch (a.type) {
      case 'project.policy.allow':
      case 'project.policy.deny':
        return { type: a.type, projectId: a.projectId, rule: a.rule, added: true };
      case 'project.requireReview':
        return { type: a.type, projectId: a.projectId, previous: !a.value, applied: a.value };
      case 'advice':
        return { type: 'advice' };
      case 'task.dependsOn':
      case 'project.routing':
      case 'project.notes.append':
        return { type: 'detect' };
      default:
        throw new EngineError('This was applied before the office recorded what was there earlier, so it cannot be put back exactly. Change it by hand in the project or employee settings.', 409);
    }
  }

  private undo(imp: Improvement, by: string, reason: string, evidence: EvidenceRef[], auto: boolean): Improvement {
    const record =
      imp.autopilot ??
      (imp.autopilot = { appliedBy: 'owner', auto: false, appliedAt: imp.decidedAt ?? imp.createdAt, widening: classify(imp, this.look).widening, undo: this.undoWithoutRecord(imp.action), probation: null, reverted: null, noAuto: false, history: [] });
    const undo = record.undo ?? this.undoWithoutRecord(imp.action);
    const result = undo.type === 'detect' ? { restored: true, note: revertDetectAction(this.eng, imp, by) } : this.takeBack(undo, by);
    const now = nowIso();
    record.reverted = { at: now, by, reason, evidence: evidence.slice(0, 12), restored: result.restored, note: result.note };
    record.noAuto = true;
    if (record.probation?.status === 'running') record.probation.status = auto ? 'reverted' : 'ended';
    record.history.push({ ts: now, what: 'reverted', by, note: truncate(`${reason} ${result.note}`, 300) });
    // Taken back by the office: it waits for a person again. Undone by a person: that is their decision on it.
    imp.status = auto ? 'proposed' : 'dismissed';
    imp.decidedAt = auto ? null : now;
    this.core.put('improvement', imp);
    this.core.audit(by, 'improvement.reverted', imp.id, { kind: imp.kind, action: imp.action, reason, restored: result.restored });
    this.core.event({
      type: 'learning.reverted',
      source: auto ? 'server' : 'owner',
      summary: `${auto ? 'Taken back by itself' : 'Undone'}: ${imp.title}`,
      projectId: imp.projectId,
      employeeId: imp.employeeId,
      data: { auto, area: AUTOPILOT_AREA, what: imp.title, why: reason, evidence, undo: auto ? { improvementId: imp.id, route: `POST /api/improvements/${imp.id}/apply` } : null, improvementId: imp.id, kind: imp.kind, restored: result.restored, note: result.note, by },
    });
    return imp;
  }

  /**
   * The office takes back one of its own changes because the record now speaks against it. The
   * proposal goes back to waiting for a person and is never applied automatically again.
   * (Public so that other learning modules can report a counter-signal of their own.)
   */
  rollback(id: string, reason: string, evidence: EvidenceRef[] = []): Improvement | null {
    const imp = this.core.improvements.get(id);
    if (!imp || imp.status !== 'applied' || !imp.autopilot?.auto) return null;
    this.undo(imp, AUTOPILOT_ACTOR, reason, evidence, true);
    // Unlike the note about applying, this one is left open: the suggestion is the owner's to decide now.
    this.eng.comms.notify({ kind: 'improvement', severity: 'info', title: `Taken back: ${imp.title}`, body: `${reason} ${imp.autopilot.reverted?.note ?? ''} The suggestion is waiting for you under Growth and will not be applied automatically again.`, projectId: imp.projectId, employeeId: imp.employeeId });
    return imp;
  }

  /** A person undoes an applied improvement, whoever applied it. Doing it twice changes nothing. */
  revert(id: string, actor = 'owner'): Improvement {
    const imp = this.core.improvements.require(id);
    if (imp.status !== 'applied') {
      if (imp.autopilot?.reverted) return imp;
      throw new EngineError(`this suggestion is not applied (${imp.status}), so there is nothing to undo`, 409);
    }
    return this.undo(imp, actor, 'Undone by a person.', [], false);
  }
}
