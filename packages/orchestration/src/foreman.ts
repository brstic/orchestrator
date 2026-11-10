import { createHash } from 'node:crypto';
import type { DeliveryState, Employee, ForemanAttentionItem, ForemanAttentionKind, ForemanRound, ForemanStatus, OrchestratorEvent, Project, Question, Task, TaskKind, TaskPriority, TaskStatus } from '@orchestrator/contracts';
import { ACTIVITY_LABEL, correlationMarker, formatDuration, newId, nowIso, redactSecrets, roleByKey, truncate } from '@orchestrator/contracts';
import type { McpToolHandler, McpToolResult } from '@orchestrator/integrations';
import type { Engine } from './engine.ts';
import type { McpContext } from './mcp-tools.ts';

/** The role whose session supervises the office. */
export const FOREMAN_ROLE = 'foreman';

const KV = 'foreman';
const ROUNDS_KEPT = 20;
/** How much of an employee's terminal `look_at` shows. */
const SCREEN_LINES = 40;
const BOARD: TaskStatus[] = ['BACKLOG', 'READY', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'DONE'];
const TASK_KINDS: TaskKind[] = ['feature', 'bug', 'test', 'review', 'research', 'planning', 'security', 'docs', 'ops', 'refactor', 'chore'];
const PRIORITIES: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];
const KIND_LABEL: Record<ForemanAttentionKind, string> = { question: 'QUESTION', blocked: 'BLOCKED', stalled: 'STALLED', unassigned: 'UNASSIGNED' };

interface Persisted {
  /** Finished rounds, newest first. */
  rounds: ForemanRound[];
  /** Attention items that were already put in front of the foreman; they do not call for another round. */
  seen: string[];
  /** Questions the foreman passed to the owner: they stay open, and stay the owner's. */
  escalated: string[];
  /** What the office looked like when the foreman last looked (or when rounds were switched on), for the quiet check. */
  fingerprint: string | null;
  checkedAt: string | null;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const shortHash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 10);
const err = (text: string): McpToolResult => ({ text, isError: true });
const emptyCounts = (): Record<ForemanAttentionKind, number> => ({ question: 0, blocked: 0, stalled: 0, unassigned: 0 });

/** A round in flight: the record, plus what the engine needs to know while it runs. */
interface LiveRound extends ForemanRound {
  foremanId: string;
  /** The attention items it was started for. */
  keys: string[];
  /** The prompt reached the foreman's session. */
  delivered: boolean;
}
/** How long a round may sit undelivered while the foreman has no running session at all. */
const NO_SESSION_GRACE_MS = 60_000;

/**
 * Whether a round should start now. No model is involved in this decision.
 *
 *  - never while a round is still running, and never sooner than the gap after the previous one;
 *  - a round when something NEW needs attention;
 *  - otherwise at most one "quiet check" per interval, and only if the office changed since the last look.
 */
export function roundDecision(i: { now: number; inFlight: boolean; fresh: number; lastRoundAt: number | null; minGapMs: number; quietCheckMs: number; lastCheckAt: number | null; changed: boolean }): 'attention' | 'quiet_check' | null {
  if (i.inFlight) return null;
  if (i.lastRoundAt !== null && i.now - i.lastRoundAt < i.minGapMs) return null;
  if (i.fresh > 0) return 'attention';
  if (i.quietCheckMs > 0 && i.changed && i.lastCheckAt !== null && i.now - i.lastCheckAt >= i.quietCheckMs) return 'quiet_check';
  return null;
}

/**
 * The foreman: an employee whose own Claude Code session supervises the office.
 *
 * The engine works out, without any model, what needs attention (a question nobody answered, a
 * blocked or stalled task, ready work next to a free employee). Only when that list has something
 * new in it is ONE round prompt delivered to the foreman's session; the prompt carries the digest.
 * The foreman then acts through its own MCP tools, all of which change real orchestration state
 * under the foreman's name. A quiet office starts no round and costs nothing.
 *
 * What the foreman may not do is as deliberate as what it may: it never decides a permission
 * request, and it has no tool that starts, stops or types into anyone's session.
 */
export class Foreman {
  private eng: Engine;
  private state: Persisted;
  private timer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private onEvent: ((e: OrchestratorEvent) => void) | null = null;
  private ticking = false;
  /** The round in flight, if any. */
  private round: LiveRound | null = null;
  private wasEnabled = false;
  private problem: string | null = null;
  private notifiedProblem: string | null = null;
  /** After a session that would not start: no further attempt before this time. */
  private retryAfter = 0;

  constructor(eng: Engine) {
    this.eng = eng;
    const saved = eng.core.store.kvGet<Partial<Persisted>>(KV, {});
    this.state = { rounds: saved.rounds ?? [], seen: saved.seen ?? [], escalated: saved.escalated ?? [], fingerprint: saved.fingerprint ?? null, checkedAt: saved.checkedAt ?? null };
  }

  private get core() {
    return this.eng.core;
  }

  private save(): void {
    this.core.store.kvSet(KV, this.state);
  }

  /** Begin watching the office. Nothing is delivered unless rounds are switched on and a foreman exists. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), Math.max(50, this.core.timings.foremanTickMs));
    this.timer.unref?.();
    // A new question should not have to wait for the next tick: look again as soon as it has settled.
    this.onEvent = (e) => {
      if (e.type === 'agent.question') this.checkSoon(this.core.timings.foremanSettleMs + 40);
    };
    this.core.bus.on('event', this.onEvent);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    if (this.onEvent) this.core.bus.off('event', this.onEvent);
    this.timer = this.soon = this.onEvent = null;
  }

  private checkSoon(ms: number): void {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.tick();
    }, ms);
    this.soon.unref?.();
  }

  /** The employee who does the rounds: the longest-serving one with the foreman role. */
  foreman(): Employee | undefined {
    return this.core.employees.filter((e) => !e.archived && e.roleKey === FOREMAN_ROLE).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
  }

  private gapMs(): number {
    return Math.max(this.core.settings.foreman.minGapSeconds * 1000, this.core.timings.foremanMinGapMs);
  }

  // ───────────────────────── what needs attention ─────────────────────────

  /** People a ready task could go to right now, most suitable first. Never the foreman. */
  private candidates(task: Task, free: Employee[]): Employee[] {
    const wanted = task.roleHint ? roleByKey(task.roleHint) : undefined;
    const fit = (e: Employee): number => (wanted ? (e.roleKey === wanted.key ? 0 : 2) : roleByKey(e.roleKey)?.handles.includes(task.kind) ? 0 : 2) + (e.projectId === task.projectId ? 0 : 1);
    return free
      .filter((e) => e.projectId === task.projectId || e.projectId === null || !!e.alsoProjectIds?.includes(task.projectId))
      .sort((a, b) => fit(a) - fit(b) || a.name.localeCompare(b.name))
      .slice(0, 5);
  }

  /**
   * Everything that currently calls for the foreman, computed from recorded state alone:
   * an employee's open question, a blocked task, someone idle with a task in progress, and
   * ready work nobody has while somebody is free. Permission requests are never in this list.
   */
  attention(now = Date.now(), boss: Employee | undefined = this.foreman()): ForemanAttentionItem[] {
    const core = this.core;
    const settle = core.timings.foremanSettleMs;
    const seen = new Set(this.state.seen);
    const out: ForemanAttentionItem[] = [];
    const add = (i: Omit<ForemanAttentionItem, 'seen' | 'escalated'>) => out.push({ ...i, seen: seen.has(i.key), escalated: !!i.questionId && this.state.escalated.includes(i.questionId) });
    const active = (projectId: string | null) => !projectId || core.projects.get(projectId)?.status === 'active';

    if (core.settings.foreman.answersQuestions) {
      for (const q of core.questions.filter((x) => x.status === 'open' && x.kind === 'question' && !!x.employeeId && x.employeeId !== boss?.id && (x.channel === 'mcp_tool' || x.channel === 'ask_user_question_hook'))) {
        if (now - Date.parse(q.createdAt) < settle) continue;
        const asker = core.employees.get(q.employeeId);
        if (!asker || asker.archived) continue;
        add({ key: `question:${q.id}`, kind: 'question', text: `${asker.name} asks: "${truncate(oneLine(q.text), 300)}"`, employeeId: asker.id, taskId: q.taskId, questionId: q.id, projectId: q.projectId, since: q.createdAt });
      }
    }

    for (const t of core.tasks.filter((x) => x.status === 'BLOCKED' && active(x.projectId))) {
      const since = [...t.history].reverse().find((h) => h.status === 'BLOCKED')?.ts ?? t.updatedAt;
      if (now - Date.parse(since) < settle) continue;
      const who = core.employees.get(t.assigneeId);
      add({ key: `blocked:${t.id}:${shortHash(t.blockedReason ?? '')}`, kind: 'blocked', text: `${t.key} "${truncate(t.title, 80)}" is blocked${who ? ` (${who.name})` : ''}: ${truncate(oneLine(t.blockedReason ?? 'no reason recorded'), 240)}`, employeeId: t.assigneeId, taskId: t.id, questionId: null, projectId: t.projectId, since });
    }

    for (const t of core.tasks.filter((x) => x.status === 'IN_PROGRESS' && !!x.assigneeId && x.assigneeId !== boss?.id && (x.delivery.status === 'sent' || x.delivery.status === 'confirmed'))) {
      const who = core.employees.get(t.assigneeId);
      const s = core.runningSessionOf(t.assigneeId);
      // Only what the session really reported: between turns, with nothing said to be going on.
      if (!who || !s || s.status !== 'running' || s.inTurn === true || (s.activity !== 'idle' && s.activity !== 'waiting_input')) continue;
      if (core.gateway.isPaused(s.id) || core.gateway.isHumanControlled(s.id)) continue;
      if (core.questions.find((q) => q.employeeId === who.id && q.status === 'open')) continue;
      const since = s.activitySince > (t.startedAt ?? '') ? s.activitySince : t.startedAt!;
      if (now - Date.parse(since) < core.timings.foremanStalledMs) continue;
      add({ key: `stalled:${t.id}:${s.activitySince}`, kind: 'stalled', text: `${who.name} has been idle for ${formatDuration(now - Date.parse(since))} with ${t.key} "${truncate(t.title, 80)}" in progress`, employeeId: who.id, taskId: t.id, questionId: null, projectId: t.projectId, since });
    }

    const free = core.employees.filter((e) => e.roleKey !== FOREMAN_ROLE && this.eng.tasks.isFree(e));
    if (free.length) {
      for (const t of core.tasks.filter((x) => x.status === 'READY' && !x.assigneeId && x.kind !== 'review' && active(x.projectId))) {
        // Give the scheduler its turn first: where a project assigns automatically, this is only what it left over.
        if (now - Date.parse(t.updatedAt) < settle) continue;
        const who = this.candidates(t, free);
        if (!who.length) continue;
        add({ key: `unassigned:${t.id}`, kind: 'unassigned', text: `${t.key} "${truncate(t.title, 80)}" [${t.kind}, ${t.priority}] in ${core.projects.get(t.projectId)?.name ?? 'a project'} is ready and unassigned — free now: ${who.map((e) => `${e.name} (${e.title})`).join(', ')}`, employeeId: null, taskId: t.id, questionId: null, projectId: t.projectId, since: t.updatedAt });
      }
    }
    return out;
  }

  /** A coarse picture of the office: which task is where, who has a session, which questions are open. */
  private fingerprint(boss: Employee | undefined): string {
    const core = this.core;
    const tasks = core.tasks.all().map((t) => `${t.id}:${t.status}:${t.assigneeId ?? '-'}`);
    const people = core.employees.filter((e) => !e.archived && e.id !== boss?.id).map((e) => `${e.id}:${core.runningSessionOf(e.id) ? 1 : 0}`);
    const questions = core.questions.filter((q) => q.status === 'open' && q.employeeId !== boss?.id).map((q) => q.id);
    return shortHash([...tasks.sort(), '|', ...people.sort(), '|', ...questions.sort()].join(','));
  }

  /** Why a round cannot be handed to the foreman right now, or null. */
  private unavailable(boss: Employee): string | null {
    const core = this.core;
    if (!boss.hostId) return `${boss.name} is not assigned to a machine.`;
    if (!core.agents.isOnline(boss.hostId)) return `${boss.name}'s machine is offline.`;
    if (!this.eng.tasks.withinSchedule(boss)) return `${boss.name} is outside their working hours (or marked unavailable).`;
    const pressure = this.eng.hosts.exhausted(boss.hostId);
    const s = core.runningSessionOf(boss.id);
    if (s) {
      if (core.gateway.isPaused(s.id)) return `${boss.name} is paused.`;
      if (!s.capabilities.mcp) return `${boss.name}'s session was attached from outside and has no Orchestrator tools; rounds need a session the office started.`;
      return null;
    }
    if (pressure) return `${boss.name}'s machine is out of resources (${pressure}); no session is started there for now.`;
    if (!boss.workingDir && !core.projects.get(boss.projectId)?.repoPath) return `${boss.name} has no folder to run in. Give them a folder (any folder: it is only where their Claude Code session runs) in their profile.`;
    return null;
  }

  private setProblem(boss: Employee, problem: string, notify: boolean): void {
    this.problem = problem;
    if (!notify || this.notifiedProblem === problem) return;
    this.notifiedProblem = problem;
    this.eng.comms.resolveNotifications((n) => n.kind === 'info' && n.employeeId === boss.id && n.title === 'The foreman could not start a round');
    this.eng.comms.notify({ kind: 'info', severity: 'warning', title: 'The foreman could not start a round', body: problem, employeeId: boss.id });
  }

  // ─────────────────────────────── rounds ───────────────────────────────

  /** One look at the office. Starts a round only when `roundDecision` says so. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const core = this.core;
      const s = core.settings.foreman;
      const boss = this.foreman();
      this.settleRound(now);
      if (!s.enabled || !boss) {
        this.wasEnabled = false;
        this.problem = null;
        return;
      }
      if (!this.wasEnabled) {
        // Switched on (or the office just started): what is there now is the baseline for the quiet check.
        this.wasEnabled = true;
        this.state.fingerprint = this.fingerprint(boss);
        this.state.checkedAt = new Date(now).toISOString();
        this.save();
      }
      if (this.round) return;
      const items = this.attention(now, boss);
      // Forget what no longer exists, so the record of what was seen stays as small as the office's open issues.
      const present = new Set(items.map((i) => i.key));
      const openQuestions = new Set(core.questions.filter((q) => q.status === 'open').map((q) => q.id));
      const seen = this.state.seen.filter((k) => present.has(k) || (k.startsWith('question:') && openQuestions.has(k.slice('question:'.length))));
      const escalated = this.state.escalated.filter((id) => openQuestions.has(id));
      if (seen.length !== this.state.seen.length || escalated.length !== this.state.escalated.length) {
        this.state.seen = seen;
        this.state.escalated = escalated;
        this.save();
      }
      const fresh = items.filter((i) => !i.seen);
      const last = this.state.rounds[0];
      const decision = roundDecision({
        now,
        inFlight: false,
        fresh: fresh.length,
        lastRoundAt: last ? Date.parse(last.finishedAt ?? last.startedAt) : null,
        minGapMs: this.gapMs(),
        quietCheckMs: s.quietCheckMinutes * 60_000,
        lastCheckAt: this.state.checkedAt ? Date.parse(this.state.checkedAt) : null,
        changed: this.state.fingerprint !== this.fingerprint(boss),
      });
      if (!decision) return;
      const why = this.unavailable(boss);
      if (why) return this.setProblem(boss, why, false);
      if (now < this.retryAfter) return;
      await this.begin(boss, decision, items, now);
    } catch (e) {
      this.core.log('error', `foreman: ${(e as Error).stack}`);
    } finally {
      this.ticking = false;
    }
  }

  private async begin(boss: Employee, reason: ForemanRound['reason'], items: ForemanAttentionItem[], now: number): Promise<void> {
    const core = this.core;
    // The same way an assignment starts a session: only if none is running, in the foreman's own folder.
    if (!core.runningSessionOf(boss.id)) {
      try {
        await this.eng.sessions.start(boss.id, { actor: 'foreman-rounds' });
      } catch (e) {
        // Said once, and not tried again on every look at the office.
        this.retryAfter = now + Math.max(this.gapMs(), 60_000);
        return this.setProblem(boss, (e as Error).message, true);
      }
    }
    this.problem = null;
    if (this.notifiedProblem) {
      this.notifiedProblem = null;
      this.eng.comms.resolveNotifications((n) => n.kind === 'info' && n.employeeId === boss.id && n.title === 'The foreman could not start a round');
    }
    const fresh = items.filter((i) => !i.seen);
    const older = items.filter((i) => i.seen);
    const counts = emptyCounts();
    for (const i of fresh) counts[i.kind]++;
    const round: LiveRound = {
      id: newId().slice(0, 8),
      foremanId: boss.id,
      reason,
      startedAt: new Date(now).toISOString(),
      finishedAt: null,
      outcome: 'running',
      summary: null,
      counts,
      fresh: fresh.length,
      stillOpen: older.length,
      visited: [],
      actions: { answered: 0, assigned: 0, created: 0, escalated: 0, messaged: 0 },
      keys: fresh.map((i) => i.key),
      delivered: false,
    };
    this.round = round;
    this.state.seen = [...new Set([...this.state.seen, ...round.keys])];
    this.state.fingerprint = this.fingerprint(boss);
    this.state.checkedAt = round.startedAt;
    this.save();
    core.event({
      type: 'foreman.round.started',
      source: 'server',
      summary: reason === 'quiet_check' ? `${boss.name} starts a quiet check of the office` : `${boss.name} starts a round: ${this.countText(counts)}`,
      employeeId: boss.id,
      correlationId: round.id,
      data: { roundId: round.id, reason, counts, fresh: fresh.length, stillOpen: older.length, items: fresh.map((i) => ({ kind: i.kind, key: i.key, text: truncate(i.text, 200) })) },
    });
    this.eng.comms.deliver(boss.id, 'ROUND', round.id, { kind: 'round', id: round.id }, this.prompt(round.id, reason, fresh, older, boss, now));
  }

  private countText(counts: Record<ForemanAttentionKind, number>): string {
    const parts = [
      counts.question ? `${counts.question} question${counts.question === 1 ? '' : 's'}` : '',
      counts.blocked ? `${counts.blocked} blocked task${counts.blocked === 1 ? '' : 's'}` : '',
      counts.stalled ? `${counts.stalled} stalled` : '',
      counts.unassigned ? `${counts.unassigned} unassigned task${counts.unassigned === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return parts.join(', ') || 'nothing new';
  }

  /** One digest line. The round prompt is built from these, so a simple round needs few tool calls. */
  private digestLine(i: ForemanAttentionItem, now: number): string {
    const core = this.core;
    const waited = formatDuration(Math.max(0, now - Date.parse(i.since)));
    if (i.kind === 'question') {
      const q = core.questions.get(i.questionId)!;
      const asker = core.employees.get(q.employeeId);
      const task = core.tasks.get(q.taskId);
      const extra = [
        q.context.trim() ? `Context: ${truncate(oneLine(q.context), 400)}` : '',
        q.why.trim() ? `Why it matters: ${truncate(oneLine(q.why), 240)}` : '',
        q.options.length ? `Options offered: ${q.options.map((o) => o.label).join(' | ')}` : '',
        q.parts.length > 1 ? `It has ${q.parts.length} parts; answer each: ${q.parts.map((p) => `"${p.question}"`).join(', ')}` : '',
      ].filter(Boolean);
      return `QUESTION ${q.id} from ${asker?.name ?? 'an employee'} (${[asker?.title, task?.key].filter(Boolean).join(', ')}): "${truncate(oneLine(q.text), 600)}" — waiting ${waited}${i.escalated ? ' — you escalated it to the boss' : ''}${extra.length ? `\n   ${extra.join('\n   ')}` : ''}`;
    }
    return `${KIND_LABEL[i.kind]} ${i.text}${i.kind === 'stalled' ? '' : ` — for ${waited}`}`;
  }

  private teamLines(boss: Employee): string[] {
    const core = this.core;
    return core.employees
      .filter((e) => !e.archived && e.id !== boss.id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => {
        const s = core.runningSessionOf(e.id);
        const t = this.eng.tasks.currentTask(e.id);
        return `- ${e.name} (${e.title}) — ${s ? (ACTIVITY_LABEL[s.activity] ?? s.activity) : 'no session'}${t ? ` · ${t.key} "${truncate(t.title, 50)}"` : ' · no task'}`;
      });
  }

  private prompt(roundId: string, reason: ForemanRound['reason'], fresh: ForemanAttentionItem[], older: ForemanAttentionItem[], boss: Employee, now: number): string {
    const lines: string[] = [];
    lines.push(`${correlationMarker('ROUND', roundId)} Foreman round — ${reason === 'quiet_check' ? 'a quiet check: nothing is waiting for you, but the office has changed since you last looked.' : `${fresh.length} thing${fresh.length === 1 ? ' needs' : 's need'} your attention.`}`);
    if (fresh.length) lines.push('', 'Needs attention now:', ...fresh.map((i, n) => `${n + 1}. ${this.digestLine(i, now)}`));
    if (older.length) lines.push('', 'Already seen in earlier rounds and still open (leave them unless something changed):', ...older.map((i) => `- ${this.digestLine(i, now)}`));
    const team = this.teamLines(boss);
    if (team.length) lines.push('', 'The team right now:', ...team);
    // Only the instructions this round needs: the prompt is paid for in tokens.
    const has = (kind: ForemanAttentionKind) => fresh.some((i) => i.kind === kind);
    lines.push(
      '',
      'What to do:',
      ...(reason === 'quiet_check' ? ['- Call office_overview, look_at anyone who seems stuck, and act only where something is wrong. If all is well, say so and finish.'] : []),
      ...(has('question') ? ["- QUESTION: if it is operational and you are sure, answer it with answer_question (use look_at first if you need to see what they are doing). If it is about direction, product or policy, about anything destructive or irreversible, or you are not sure: escalate_to_owner with its question_id and leave it open."] : []),
      ...(has('blocked') || has('stalled') ? ['- BLOCKED / STALLED: look_at the employee, then tell them what to do with send_message, or escalate_to_owner.'] : []),
      ...(has('unassigned') ? ['- UNASSIGNED: give it to the most suitable free person with assign_task.'] : []),
      '- You never approve permission requests, and you do not write code.',
      'Finish with finish_round and a summary of one or two sentences. This is one round: when it is done, stop. Do not wait, poll or start another one yourself.',
    );
    return lines.join('\n');
  }

  /** The delivery queue reports what became of the round prompt. */
  onDeliveryState(roundId: string, state: DeliveryState): void {
    const r = this.round;
    if (!r || r.id !== roundId) return;
    if (state.status === 'sent' || state.status === 'confirmed') r.delivered = true;
    else if (state.status === 'failed') this.finish('failed', `The round could not be delivered: ${state.detail ?? 'unknown error'}`);
  }

  /** The foreman's turn ended. A round that was delivered and not closed with finish_round ends here. */
  onTurnFinished(employeeId: string): void {
    if (this.round && this.round.foremanId === employeeId && this.round.delivered) this.finish('turn_ended', null);
  }

  /** A round does not stay open for ever: a foreman whose session went away, or who never ends the turn, is given up on. */
  private settleRound(now: number): void {
    const r = this.round;
    if (!r) return;
    const boss = this.core.employees.get(r.foremanId);
    if (!boss || boss.archived) return this.finish('interrupted', 'The foreman is no longer there.');
    const age = now - Date.parse(r.startedAt);
    if (!this.core.runningSessionOf(boss.id)) {
      if (r.delivered) return this.finish('interrupted', "The foreman's session stopped during the round.");
      if (age > NO_SESSION_GRACE_MS) return this.finish('failed', "The foreman's session is not running, so the round could not be delivered.");
    }
    if (age > this.core.timings.foremanRoundTimeoutMs) this.finish('timed_out', r.delivered ? 'The foreman did not end the round in time.' : 'The round was never delivered to the foreman.');
  }

  private finish(outcome: Exclude<ForemanRound['outcome'], 'running'>, summary: string | null): void {
    const r = this.round;
    if (!r) return;
    this.round = null;
    const boss = this.core.employees.get(r.foremanId);
    if (!r.delivered) {
      // Nothing reached the foreman: what the round was about is still unseen.
      this.eng.comms.cancelFor({ kind: 'round', id: r.id });
      const mine = new Set(r.keys);
      this.state.seen = this.state.seen.filter((k) => !mine.has(k));
    }
    const { foremanId: _f, keys: _k, delivered: _d, ...record } = r;
    const done: ForemanRound = { ...record, finishedAt: nowIso(), outcome, summary };
    this.state.rounds = [done, ...this.state.rounds].slice(0, ROUNDS_KEPT);
    if (r.delivered) {
      // The quiet check compares against the office as the foreman left it, not as it found it.
      this.state.fingerprint = this.fingerprint(boss);
      this.state.checkedAt = done.finishedAt;
    }
    this.save();
    const acts = done.actions;
    this.core.event({
      type: 'foreman.round.finished',
      source: outcome === 'finished' ? 'mcp' : 'server',
      summary: outcome === 'finished' ? `${boss?.name ?? 'The foreman'} finished the round: ${truncate(summary ?? '', 160)}` : `${boss?.name ?? 'The foreman'}'s round ended (${outcome.replace('_', ' ')})${summary ? `: ${truncate(summary, 160)}` : ''}`,
      employeeId: r.foremanId,
      correlationId: r.id,
      data: { roundId: r.id, reason: r.reason, outcome, summary, counts: r.counts, visited: r.visited.length, ...acts, durationMs: Date.parse(done.finishedAt!) - Date.parse(r.startedAt) },
    });
  }

  /** Where things stand, for the owner. */
  status(): ForemanStatus {
    const core = this.core;
    const boss = this.foreman();
    const now = Date.now();
    const s = boss ? core.runningSessionOf(boss.id) : undefined;
    const last = this.state.rounds[0] ?? null;
    const why = boss ? this.unavailable(boss) : 'Nobody in the office has the Foreman role. Hire one (Team → Hire, role "Foreman") and give them a folder.';
    const lastEnd = last ? Date.parse(last.finishedAt ?? last.startedAt) : null;
    let round: ForemanRound | null = null;
    if (this.round) {
      const { foremanId: _f, keys: _k, delivered: _d, ...record } = this.round;
      round = record;
    }
    return {
      settings: core.settings.foreman,
      foreman: boss ? { id: boss.id, name: boss.name, session: s?.status ?? null, activity: s?.activity ?? null } : null,
      otherForemen: core.employees.filter((e) => !e.archived && e.roleKey === FOREMAN_ROLE && e.id !== boss?.id).map((e) => e.name),
      available: !!boss && !why,
      problem: why ?? this.problem,
      round,
      lastRound: last,
      rounds: this.state.rounds.slice(0, 10),
      attention: this.attention(now, boss),
      minGapSeconds: Math.round(this.gapMs() / 1000),
      earliestNextRoundAt: lastEnd !== null && lastEnd + this.gapMs() > now ? new Date(lastEnd + this.gapMs()).toISOString() : null,
    };
  }

  // ─────────────────────────────── tools ───────────────────────────────

  private findQuestion(ref: string): Question | undefined {
    const id = ref.trim();
    if (!id) return undefined;
    const exact = this.core.questions.get(id);
    if (exact) return exact;
    const starts = id.length >= 6 ? this.core.questions.filter((q) => q.id.startsWith(id)) : [];
    return starts.length === 1 ? starts[0] : undefined;
  }

  private findProject(ref: string): Project | undefined {
    const n = ref.trim().toLowerCase();
    const live = this.core.projects.filter((p) => p.status !== 'archived');
    const starts = n ? live.filter((p) => p.name.toLowerCase().startsWith(n)) : [];
    return this.core.projects.get(ref.trim()) ?? live.find((p) => p.name.toLowerCase() === n) ?? (starts.length === 1 ? starts[0] : undefined);
  }

  private findEmployee(ref: string): Employee | undefined {
    const e = this.core.employeeByName(ref) ?? this.core.employees.get(ref.trim());
    return e && !e.archived ? e : undefined;
  }

  /** The round this foreman is on right now, if any. */
  private roundOf(employee: Employee): LiveRound | null {
    return this.round && this.round.foremanId === employee.id ? this.round : null;
  }

  /** Counts what the foreman did, on the round it was done in. */
  private did(employee: Employee, what: keyof ForemanRound['actions']): void {
    const r = this.roundOf(employee);
    if (r) r.actions[what]++;
  }

  /** Something the foreman may not do was asked for: said clearly, and kept on the record. */
  private refuse(employee: Employee, tool: string, reason: string, target = '-'): McpToolResult {
    this.core.audit(`foreman:${employee.name}`, 'foreman.refused', target, { tool, reason });
    return err(reason);
  }

  private overview(boss: Employee): string {
    const core = this.core;
    const now = Date.now();
    const people = core.employees.filter((e) => !e.archived && e.id !== boss.id).sort((a, b) => a.name.localeCompare(b.name));
    const projects = core.projects.filter((p) => p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name));
    const lines: string[] = [`Office overview — ${people.length} employee${people.length === 1 ? '' : 's'}, ${projects.length} project${projects.length === 1 ? '' : 's'}.`, '', 'People:'];
    if (!people.length) lines.push('- nobody else works here yet');
    for (const e of people) {
      const s = core.sessionOf(e.id);
      const live = s && (s.status === 'running' || s.status === 'starting');
      const task = this.eng.tasks.currentTask(e.id);
      const waiting = core.tasks.filter((t) => t.assigneeId === e.id && (t.status === 'READY' || t.status === 'BLOCKED' || t.status === 'REVIEW'));
      const q = core.questions.find((x) => x.employeeId === e.id && x.status === 'open' && x.channel !== 'system');
      const state = !s ? 'no session yet' : !live ? `no running session (${s.status}${s.exitReason ? `: ${truncate(s.exitReason, 60)}` : ''})` : `${ACTIVITY_LABEL[s.activity] ?? s.activity} for ${formatDuration(now - Date.parse(s.activitySince))}${s.activityDetail ? ` ("${truncate(oneLine(s.activityDetail), 70)}")` : ''}`;
      lines.push(
        `- ${e.name} — ${e.title} · ${core.projects.get(e.projectId)?.name ?? 'no project'} · ${state} · ${task ? `${task.key} [${task.status}] "${truncate(task.title, 60)}"${task.progress.percent != null ? ` ${task.progress.percent}%` : ''}` : 'no task in progress'}${waiting.length ? ` · also theirs: ${waiting.map((t) => `${t.key} [${t.status}]`).join(', ')}` : ''}${q ? ` · open ${q.kind === 'permission' || q.kind === 'trust_prompt' ? 'approval request (the boss decides)' : q.kind} ${q.id}: "${truncate(oneLine(q.text), 120)}"` : ''}`,
      );
    }
    lines.push('', 'Projects:');
    if (!projects.length) lines.push('- no projects yet');
    for (const p of projects) {
      const tasks = core.tasks.filter((t) => t.projectId === p.id && t.kind !== 'review');
      lines.push(`- ${p.name} (${p.status}${p.policy.autoAssign ? ', assigns ready work automatically' : ', work is assigned by hand'}): ${BOARD.map((st) => `${st} ${tasks.filter((t) => t.status === st).length}`).join(' · ')}`);
      const ready = tasks.filter((t) => t.status === 'READY' && !t.assigneeId);
      if (ready.length) lines.push(`  Ready and unassigned: ${ready.slice(0, 12).map((t) => `${t.key} [${t.kind}, ${t.priority}] "${truncate(t.title, 60)}"${t.roleHint ? ` (role: ${t.roleHint})` : ''}`).join('; ')}${ready.length > 12 ? `; … ${ready.length - 12} more` : ''}`);
      const held = tasks.filter((t) => t.status === 'BACKLOG' && !t.released);
      if (held.length) lines.push(`  Waiting for the boss to release them: ${held.slice(0, 12).map((t) => t.key).join(', ')}${held.length > 12 ? ', …' : ''}`);
      for (const t of tasks.filter((x) => x.status === 'BLOCKED')) lines.push(`  Blocked: ${t.key} "${truncate(t.title, 60)}" (${core.employees.get(t.assigneeId)?.name ?? 'unassigned'}): ${truncate(oneLine(t.blockedReason ?? 'no reason recorded'), 200)}`);
    }
    return lines.join('\n');
  }

  private lookAt(boss: Employee, target: Employee, sessionId: string): string {
    const core = this.core;
    const now = Date.now();
    const s = core.sessionOf(target.id);
    const live = !!s && (s.status === 'running' || s.status === 'starting');
    const task = this.eng.tasks.currentTask(target.id);
    const lines: string[] = [`${target.name} — ${target.title} · ${core.projects.get(target.projectId)?.name ?? 'no project'}`];
    lines.push(!s ? 'Session: none yet.' : !live ? `Session: not running (${s.status}${s.exitReason ? `: ${s.exitReason}` : ''}).` : `Session: ${ACTIVITY_LABEL[s.activity] ?? s.activity} for ${formatDuration(now - Date.parse(s.activitySince))}${s.activityDetail ? ` — ${oneLine(s.activityDetail)}` : ''}${s.inTurn === true ? ' (in the middle of a turn)' : s.inTurn === false ? ' (between turns)' : ''}.`);
    if (task) {
      lines.push('', `Current task: ${task.key} [${task.status}] ${task.title} (${task.kind}, ${task.priority})`, truncate(task.description.trim() || '(no description)', 1500));
      if (task.acceptance.trim()) lines.push(`Acceptance criteria: ${truncate(task.acceptance.trim(), 600)}`);
      if (task.progress.note) lines.push(`Last progress report: ${truncate(task.progress.note, 200)}${task.progress.percent != null ? ` (${task.progress.percent}%)` : ''}`);
    } else {
      const theirs = core.tasks.filter((t) => t.assigneeId === target.id && (t.status === 'READY' || t.status === 'BLOCKED' || t.status === 'REVIEW'));
      lines.push('', theirs.length ? `No task in progress. Assigned to them: ${theirs.map((t) => `${t.key} [${t.status}] ${truncate(t.title, 60)}${t.blockedReason ? ` (${truncate(t.blockedReason, 120)})` : ''}`).join('; ')}` : 'No task.');
    }
    const q = core.questions.find((x) => x.employeeId === target.id && x.status === 'open' && x.channel !== 'system');
    if (q) lines.push('', `Open ${q.kind === 'permission' || q.kind === 'trust_prompt' ? 'approval request (only the boss can decide it)' : q.kind} ${q.id}: "${truncate(oneLine(q.text), 600)}"`);
    const events = core.store.queryEvents({ employeeId: target.id, limit: 12, excludeTypes: ['session.activity', 'terminal.output', 'agent.prompt_submitted'] });
    if (events.length) lines.push('', 'Recent events:', ...events.map((e) => `- ${e.ts.slice(11, 19)} ${truncate(e.summary, 160)}`));
    // The screen is the real one, as last captured from their terminal. Nothing is invented when there is none.
    const screen = live ? core.gateway.screens.get(s!.id) : undefined;
    let shown = false;
    if (screen) {
      const text = screen.lines.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+$/, ''));
      while (text.length && !text[text.length - 1]) text.pop();
      const tail = text.slice(-SCREEN_LINES).map((l) => redactSecrets(truncate(l, 220)));
      if (tail.length) {
        shown = true;
        lines.push('', `Their terminal screen, captured ${formatDuration(Math.max(0, now - Date.parse(screen.ts)))} ago (last ${tail.length} line${tail.length === 1 ? '' : 's'}):`, '```', ...tail, '```');
      }
    }
    if (!shown) lines.push('', live ? 'Their terminal screen: not available (no screen has been captured for this session yet).' : 'Their terminal screen: not available (no session is running).');
    // The visit is on the record (and is what makes the foreman's character walk over); what was on the screen is not.
    const round = this.roundOf(boss);
    this.core.event({ type: 'foreman.visit', source: 'mcp', summary: `${boss.name} looked at what ${target.name} is doing`, employeeId: boss.id, sessionId, projectId: target.projectId, correlationId: round?.id ?? null, data: { fromEmployeeId: boss.id, toEmployeeId: target.id, roundId: round?.id ?? null, screen: shown } });
    if (round && !round.visited.includes(target.id)) round.visited.push(target.id);
    return lines.join('\n');
  }

  /** The foreman's MCP tools. Every one of them refuses a caller who is not a foreman. */
  handlers(): Record<string, McpToolHandler<McpContext>> {
    const core = this.core;
    const only =
      (tool: string, fn: McpToolHandler<McpContext>): McpToolHandler<McpContext> =>
      async (args, ctx) => {
        if (ctx.employee.roleKey !== FOREMAN_ROLE) {
          core.audit(`employee:${ctx.employee.name}`, 'foreman.tool_refused', tool, { role: ctx.employee.roleKey });
          return err(`Only the foreman can use ${tool}. You are ${ctx.employee.title}; use ask_boss, send_message or request_collaboration instead.`);
        }
        return fn(args, ctx);
      };
    const actor = (e: Employee) => `foreman:${e.name}`;

    const tools: Record<string, McpToolHandler<McpContext>> = {
      office_overview: async (_a, { employee }) => this.overview(employee),

      look_at: async (a, { employee, session }) => {
        const target = this.findEmployee(String(a.employee));
        if (!target) return err(`No employee matches "${a.employee}". Use office_overview to see who works here.`);
        if (target.id === employee.id) return err('That is you. Use look_at on someone else.');
        return this.lookAt(employee, target, session.id);
      },

      answer_question: async (a, { employee }) => {
        const q = this.findQuestion(String(a.question_id));
        if (!q) return err(`No question "${a.question_id}". Use office_overview to see the open ones.`);
        // The same line a colleague the owner invited is held to: a question may be answered, an action may not be approved.
        if (q.kind === 'permission' || q.kind === 'trust_prompt') return this.refuse(employee, 'answer_question', 'Only the owner can decide a permission request. Leave it with them; it is already in their inbox.', q.id);
        if (q.kind !== 'question') return this.refuse(employee, 'answer_question', `This is a ${q.kind.replace('_', ' ')} for the owner, not an operational question. Leave it with them (escalate_to_owner if it is urgent).`, q.id);
        if (!core.settings.foreman.answersQuestions) return this.refuse(employee, 'answer_question', 'The owner has switched off answering by the foreman; questions wait for the owner.', q.id);
        if (q.employeeId === employee.id) return err('That is your own question; it waits for the owner.');
        if (this.state.escalated.includes(q.id)) return this.refuse(employee, 'answer_question', 'You escalated this question to the owner; it stays with them.', q.id);
        if (q.status !== 'open') return err(`That question is no longer open (${q.status}); someone already dealt with it.`);
        const answer = String(a.answer).trim();
        let answers: Record<string, string> | null = null;
        if (q.parts.length === 1) answers = { [q.parts[0]!.question]: answer };
        else if (q.parts.length > 1) {
          const given = a.answers && typeof a.answers === 'object' && !Array.isArray(a.answers) ? (a.answers as Record<string, unknown>) : {};
          answers = {};
          for (const part of q.parts) {
            const v = given[part.question];
            if (typeof v !== 'string' || !v.trim()) return err(`This question has ${q.parts.length} parts. Pass "answers" with one entry per part, keyed by the part's exact text: ${q.parts.map((p) => `"${p.question}"`).join(', ')}.`);
            answers[part.question] = v.trim();
          }
        }
        await this.eng.comms.answer(q.id, { answer, answers }, actor(employee), { kind: 'foreman', id: employee.id, name: employee.name });
        this.did(employee, 'answered');
        return `Answered ${core.employees.get(q.employeeId)?.name ?? 'the employee'}'s question on the owner's behalf. It is on the record as answered by you.`;
      },

      assign_task: async (a, { employee }) => {
        const task = this.eng.tasks.taskByKey(String(a.task));
        if (!task) return err(`No task "${a.task}". Use office_overview to see the board.`);
        const to = this.findEmployee(String(a.employee));
        if (!to) return err(`No employee matches "${a.employee}". Use office_overview to see who works here.`);
        if (to.roleKey === FOREMAN_ROLE) return err('A foreman supervises and does not take tasks. Assign it to someone who does the work.');
        if (task.assigneeId === to.id) return `${task.key} is already assigned to ${to.name}.`;
        this.eng.tasks.updateTask(task.id, { assigneeId: to.id }, actor(employee));
        this.did(employee, 'assigned');
        const next = task.status === 'READY' ? 'It is handed to them as soon as they are free.' : task.status === 'BACKLOG' ? (task.released ? 'It starts once its dependencies are done.' : 'It is not released yet: it starts once the owner releases it.') : `It is ${task.status}.`;
        return `${task.key} "${truncate(task.title, 80)}" is now assigned to ${to.name}. ${next}`;
      },

      create_task: async (a, { employee }) => {
        const project = this.findProject(String(a.project));
        if (!project) return err(`No project matches "${a.project}". Projects: ${core.projects.filter((p) => p.status !== 'archived').map((p) => p.name).join(', ') || 'none'}.`);
        if (project.status !== 'active') return err(`${project.name} is ${project.status}; the owner decides when work on it continues.`);
        let assigneeId: string | null = null;
        if (a.assignee) {
          const to = this.findEmployee(String(a.assignee));
          if (!to) return err(`No employee matches "${a.assignee}".`);
          if (to.roleKey === FOREMAN_ROLE) return err('A foreman supervises and does not take tasks.');
          assigneeId = to.id;
        }
        const task = this.eng.tasks.createTask(
          {
            projectId: project.id,
            title: truncate(oneLine(String(a.title)), 160),
            description: String(a.description ?? ''),
            acceptance: a.acceptance ? String(a.acceptance) : '',
            assigneeId,
            priority: PRIORITIES.includes(a.priority) ? a.priority : 'normal',
            kind: TASK_KINDS.includes(a.kind) ? a.kind : 'feature',
          },
          actor(employee),
        );
        this.did(employee, 'created');
        return `Created ${task.key} "${task.title}" in ${project.name}${assigneeId ? `, assigned to ${core.employees.get(assigneeId)?.name}` : ', unassigned'} (${task.status}).`;
      },

      escalate_to_owner: async (a, { employee, session }) => {
        const q = a.question_id ? this.findQuestion(String(a.question_id)) : undefined;
        if (a.question_id && !q) return err(`No question "${a.question_id}".`);
        if (q && q.status !== 'open') return err(`That question is no longer open (${q.status}).`);
        const summary = truncate(oneLine(String(a.summary)), 160);
        const detail = truncate(String(a.detail).trim(), 2000);
        const asker = q ? core.employees.get(q.employeeId) : undefined;
        this.eng.comms.notify({
          kind: q ? 'question' : 'info',
          severity: 'warning',
          title: `Foreman ${employee.name} needs you: ${summary}`,
          body: q ? `${asker?.name ?? 'An employee'} asked: "${truncate(oneLine(q.text), 300)}"\n\n${detail}` : detail,
          employeeId: q?.employeeId ?? employee.id,
          sessionId: q?.sessionId ?? session.id,
          taskId: q?.taskId ?? null,
          projectId: q?.projectId ?? null,
          questionId: q?.id ?? null,
        });
        if (q && !this.state.escalated.includes(q.id)) {
          this.state.escalated.push(q.id);
          this.save();
        }
        core.audit(actor(employee), 'foreman.escalated', q?.id ?? '-', { summary });
        core.event({ type: 'foreman.escalated', source: 'mcp', summary: `${employee.name} escalated to the boss: ${summary}`, employeeId: employee.id, sessionId: session.id, taskId: q?.taskId ?? null, projectId: q?.projectId ?? null, correlationId: q?.id ?? null, data: { questionId: q?.id ?? null, aboutEmployeeId: q?.employeeId ?? null, roundId: this.roundOf(employee)?.id ?? null } });
        this.did(employee, 'escalated');
        return q ? `The owner has been notified. ${asker?.name ?? 'The employee'}'s question stays open for them; do not answer it yourself.` : 'The owner has been notified.';
      },

      finish_round: async (a, { employee }) => {
        const round = this.roundOf(employee);
        if (!round) return 'No round is in progress, so there is nothing to record.';
        round.delivered = true;
        this.finish('finished', truncate(String(a.summary).trim(), 600));
        return 'Round recorded. Stop here; you are called again when something needs you.';
      },
    };
    return Object.fromEntries(Object.entries(tools).map(([name, fn]) => [name, only(name, fn)]));
  }

  /** The foreman told someone something (the ordinary send_message tool): counted on the round. */
  noteMessage(employee: Employee): void {
    if (employee.roleKey === FOREMAN_ROLE) this.did(employee, 'messaged');
  }
}
