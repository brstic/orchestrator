import { createHash } from 'node:crypto';
import type { DeliveryState, Employee, ForemanAttentionItem, ForemanAttentionKind, ForemanRound, ForemanStatus, OrchestratorEvent, Project, Question, Task, TaskKind, TaskPriority, TaskStatus } from '@orchestrator/contracts';
import { ACTIVITY_LABEL, correlationMarker, formatDuration, newId, nowIso, redactSecrets, roleByKey, truncate } from '@orchestrator/contracts';
import type { McpToolHandler, McpToolResult } from '@orchestrator/integrations';
import { plainScreen } from './comms.ts';
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
const KIND_LABEL: Record<ForemanAttentionKind, string> = { question: 'QUESTION', blocked: 'BLOCKED', stalled: 'STALLED', unassigned: 'UNASSIGNED', idle: 'IDLE', waiting: 'WAITING' };

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
  /**
   * Per employee: when "doing nothing" was last put in front of the foreman, and how many times in a row with
   * nothing but the foreman's own words reaching them in between. Each such time doubles how long they are left
   * alone, so a foreman and an employee with nothing to do never talk in circles.
   */
  idle: Record<string, { shownAt: string; streak: number }>;
}

/** The longest the wait for the next "doing nothing" grows to: 2^5 times the owner's setting. */
const IDLE_BACKOFF_MAX = 5;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const shortHash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 10);
const err = (text: string): McpToolResult => ({ text, isError: true });
const emptyCounts = (): Record<ForemanAttentionKind, number> => ({ question: 0, blocked: 0, stalled: 0, unassigned: 0, idle: 0, waiting: 0 });

/** A round in flight: the record, plus what the engine needs to know while it runs. */
interface LiveRound extends ForemanRound {
  foremanId: string;
  /** The attention items it was started for. */
  keys: string[];
  /** The prompt reached the foreman's session. */
  delivered: boolean;
  /** What was on record about idle employees before this round showed them, to put back if the round never arrives. */
  idleBefore: Record<string, { shownAt: string; streak: number } | null>;
  /** Who the foreman is with right now: the last employee it looked at, answered or told something. */
  visiting: string | null;
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
 * The foreman: the office's one supervisor. It has a Claude Code session of its own on one of the
 * office's machines and no desk — it walks the floor. It looks after everyone: the shared office and
 * the employees on members' own computers (while those computers are in the office).
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
    this.state = { rounds: saved.rounds ?? [], seen: saved.seen ?? [], escalated: saved.escalated ?? [], fingerprint: saved.fingerprint ?? null, checkedAt: saved.checkedAt ?? null, idle: saved.idle ?? {} };
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

  /** Is a round in flight right now? */
  inRound(): boolean {
    return !!this.round;
  }

  /** The employee who does the rounds. (An office from before there could only be one: the longest-serving of them.) */
  foreman(): Employee | undefined {
    return this.core.employees.filter((e) => !e.archived && e.roleKey === FOREMAN_ROLE).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
  }

  /** A foreman was just hired: that is the owner asking for rounds, so they are on from here (and can be paused in Settings). */
  onHired(): void {
    if (!this.core.settings.foreman.enabled) this.core.updateSettings({ foreman: { ...this.core.settings.foreman, enabled: true } });
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
   * an employee's open question, a blocked task, someone idle with a task in progress, someone
   * waiting for a colleague who is doing nothing, and ready work nobody has while somebody is free.
   * Permission requests are never in this list.
   */
  /** Is this host a member's own computer? */
  private personal(hostId: string | null | undefined): boolean {
    return !!this.eng.hosts.memberOfHost(hostId);
  }

  /** Has the member whose computer this is closed their room? Then it is theirs alone, and the foreman stays out like everyone else. */
  private closed(hostId: string | null | undefined): boolean {
    return this.eng.hosts.isClosed(this.eng.hosts.memberOfHost(hostId));
  }

  /** What the foreman is told when it reaches for someone in a closed room. */
  private closedSay(name: string): string {
    return `${name} is on a member's own computer, and that member has closed their room: what is there is theirs alone. Leave them be.`;
  }

  /**
   * On a member's own computer that is not in the office right now, or whose member has closed their room: nothing
   * can be seen or delivered there, so they are passed by.
   */
  private away(e: Employee | undefined): boolean {
    return !!e && this.personal(e.hostId) && (!this.core.agents.isOnline(e.hostId!) || this.closed(e.hostId));
  }

  /** Whose computer someone is on, in words: "" for the office's own machines. */
  private where(e: Employee): string {
    const host = this.personal(e.hostId) ? this.core.hosts.get(e.hostId!) : undefined;
    return host ? ` · on ${host.memberName ?? host.name}'s own computer${this.core.agents.isOnline(host.id) ? '' : ' (away)'}` : '';
  }

  /**
   * Work stays on the computer its project is on: a shared project's task never goes to an employee on a
   * member's own computer, and a task of a project on a member's computer goes only to an employee there.
   */
  private sameComputer(e: Employee, projectId: string | null | undefined): boolean {
    const projectHost = this.core.projects.get(projectId ?? '')?.hostId ?? null;
    return !(this.personal(e.hostId) || this.personal(projectHost)) || e.hostId === projectHost;
  }

  /** How long doing nothing has to last before the foreman is called. 0: never (the owner's setting). */
  private idleMs(): number {
    const minutes = this.core.settings.foreman.idleMinutes;
    return minutes > 0 ? (this.core.timings.foremanIdleMs ?? minutes * 60_000) : 0;
  }

  /** When something other than the foreman last gave this employee something to do: a message, an answer from the owner, a task that started. */
  private lastOutsideInput(who: Employee, boss: Employee | undefined): string {
    const core = this.core;
    let last = '';
    const at = (ts: string | null | undefined) => {
      if (ts && ts > last) last = ts;
    };
    for (const m of core.messages.filter((x) => x.toEmployeeId === who.id && x.from.id !== boss?.id && x.from.kind !== 'system')) at(m.createdAt);
    for (const t of core.tasks.filter((x) => x.assigneeId === who.id)) at(t.startedAt);
    for (const q of core.questions.filter((x) => x.employeeId === who.id && x.answeredBy?.kind !== 'foreman')) at(q.answeredAt);
    return last;
  }

  /** How many times in a row this employee's idleness was shown to the foreman with nothing from anyone else in between. */
  private idleStreak(who: Employee, boss: Employee | undefined): number {
    const rec = this.state.idle[who.id];
    return rec && !(this.lastOutsideInput(who, boss) > rec.shownAt) ? rec.streak : 0;
  }

  attention(now = Date.now(), boss: Employee | undefined = this.foreman()): ForemanAttentionItem[] {
    const core = this.core;
    const settle = core.timings.foremanSettleMs;
    const seen = new Set(this.state.seen);
    const out: ForemanAttentionItem[] = [];
    const add = (i: Omit<ForemanAttentionItem, 'seen' | 'escalated'>) => out.push({ ...i, seen: seen.has(i.key), escalated: !!i.questionId && this.state.escalated.includes(i.questionId) });
    // The whole office is the foreman's: the shared floor and members' rooms alike. A member's computer that is away is passed by.
    const there = (projectId: string | null) => {
      const host = core.projects.get(projectId ?? '')?.hostId;
      return !this.personal(host) || (core.agents.isOnline(host!) && !this.closed(host));
    };
    const active = (projectId: string | null) => !projectId || (core.projects.get(projectId)?.status === 'active' && there(projectId));

    if (core.settings.foreman.answersQuestions) {
      for (const q of core.questions.filter((x) => x.status === 'open' && x.kind === 'question' && !!x.employeeId && x.employeeId !== boss?.id && (x.channel === 'mcp_tool' || x.channel === 'ask_user_question_hook'))) {
        if (now - Date.parse(q.createdAt) < settle) continue;
        const asker = core.employees.get(q.employeeId);
        if (!asker || asker.archived || this.away(asker)) continue;
        add({ key: `question:${q.id}`, kind: 'question', text: `${asker.name} asks: "${truncate(oneLine(q.text), 300)}"`, employeeId: asker.id, taskId: q.taskId, questionId: q.id, projectId: q.projectId, since: q.createdAt });
      }
    }

    for (const t of core.tasks.filter((x) => x.status === 'BLOCKED' && active(x.projectId))) {
      const since = [...t.history].reverse().find((h) => h.status === 'BLOCKED')?.ts ?? t.updatedAt;
      if (now - Date.parse(since) < settle) continue;
      const who = core.employees.get(t.assigneeId);
      add({ key: `blocked:${t.id}:${shortHash(t.blockedReason ?? '')}`, kind: 'blocked', text: `${t.key} "${truncate(t.title, 80)}" is blocked${who ? ` (${who.name})` : ''}: ${truncate(oneLine(t.blockedReason ?? 'no reason recorded'), 240)}`, employeeId: t.assigneeId, taskId: t.id, questionId: null, projectId: t.projectId, since });
    }

    for (const t of core.tasks.filter((x) => x.status === 'IN_PROGRESS' && !!x.assigneeId && x.assigneeId !== boss?.id && active(x.projectId) && (x.delivery.status === 'sent' || x.delivery.status === 'confirmed'))) {
      const who = core.employees.get(t.assigneeId);
      const s = core.runningSessionOf(t.assigneeId);
      // Only what the session really reported: between turns, with nothing said to be going on.
      if (!who || !s || s.status !== 'running' || s.inTurn === true || (s.activity !== 'idle' && s.activity !== 'waiting_input')) continue;
      if (this.away(who) || core.gateway.isPaused(s.id) || core.gateway.isHumanControlled(s.id)) continue;
      if (core.questions.find((q) => q.employeeId === who.id && q.status === 'open')) continue;
      // Stopped because a colleague has not answered or finished: that is "waiting", below, and only when the colleague is not at it.
      if (s.waitingOn) continue;
      const since = s.activitySince > (t.startedAt ?? '') ? s.activitySince : t.startedAt!;
      if (now - Date.parse(since) < core.timings.foremanStalledMs) continue;
      add({ key: `stalled:${t.id}:${s.activitySince}`, kind: 'stalled', text: `${who.name} has been idle for ${formatDuration(now - Date.parse(since))} with ${t.key} "${truncate(t.title, 80)}" in progress`, employeeId: who.id, taskId: t.id, questionId: null, projectId: t.projectId, since });
    }

    // Doing nothing at all: a live session between turns with no task in progress. Each such spell is shown to the
    // foreman once (the key carries when it began), so someone left alone on purpose is not asked about again.
    const idleMs = this.idleMs();
    if (idleMs > 0) {
      // A person's own session is theirs to leave idle: the foreman does not ask about it.
      for (const who of core.employees.filter((e) => !e.archived && e.roleKey !== FOREMAN_ROLE && !e.selfDriven && !this.away(e))) {
        const s = core.runningSessionOf(who.id);
        if (!s || s.status !== 'running' || s.inTurn === true || (s.activity !== 'idle' && s.activity !== 'waiting_input' && s.activity !== 'task_complete')) continue;
        if (core.gateway.isPaused(s.id) || core.gateway.isHumanControlled(s.id) || !this.eng.tasks.withinSchedule(who)) continue;
        if (core.tasks.find((t) => t.assigneeId === who.id && t.status === 'IN_PROGRESS')) continue; // that is "stalled", above
        if (core.questions.find((q) => q.employeeId === who.id && q.status === 'open')) continue;
        if (s.waitingOn) continue; // "waiting", below
        // Left alone for twice as long each time the foreman was the only one who had anything for them.
        if (now - Date.parse(s.activitySince) < idleMs * 2 ** Math.min(this.idleStreak(who, boss), IDLE_BACKOFF_MAX)) continue;
        const waiting = core.tasks.filter((t) => t.assigneeId === who.id && (t.status === 'READY' || t.status === 'BLOCKED'));
        add({ key: `idle:${who.id}:${s.activitySince}`, kind: 'idle', text: `${who.name} (${who.title}) has been doing nothing for ${formatDuration(now - Date.parse(s.activitySince))}: no task in progress${waiting.length ? `; assigned and waiting: ${waiting.map((t) => `${t.key} [${t.status}]`).join(', ')}` : ''}${this.where(who)}`, employeeId: who.id, taskId: null, questionId: null, projectId: who.projectId, since: s.activitySince });
      }
    }

    // Someone who cannot go on until a colleague has answered or finished, while that colleague is not at it (no
    // session, or between turns with nothing going on). While the colleague works on it, a wait is nobody's problem.
    for (const s of core.sessions.filter((x) => !!x.waitingOn && x.status === 'running')) {
      const w = s.waitingOn!;
      const waiter = core.employees.get(s.employeeId);
      if (!waiter || waiter.archived || waiter.id === boss?.id || this.away(waiter) || core.gateway.isPaused(s.id)) continue;
      const lazy = this.eng.waits.idleTarget(w);
      if (!lazy || lazy.who.id === boss?.id || this.away(lazy.who)) continue;
      // Both must have lasted: the wait, and the colleague's doing nothing.
      const since = lazy.since > w.since ? lazy.since : w.since;
      if (now - Date.parse(since) < core.timings.foremanWaitingMs) continue;
      const c = core.collabs.get(w.requestId);
      const t = core.tasks.get(w.taskId);
      const what = c ? `an answer to "${truncate(oneLine(c.summary), 100)}" (request ${c.id})` : `${t?.key ?? 'a task'} "${truncate(t?.title ?? '', 80)}" [${t?.status ?? 'gone'}] to be finished`;
      add({ key: `waiting:${waiter.id}:${w.requestId ?? w.taskId}`, kind: 'waiting', text: `${waiter.name} has been waiting ${formatDuration(now - Date.parse(w.since))} for ${lazy.who.name}, who ${lazy.words}: ${what}${this.where(lazy.who)}`, employeeId: waiter.id, taskId: w.taskId, questionId: null, projectId: waiter.projectId, since });
    }

    const free = core.employees.filter((e) => e.roleKey !== FOREMAN_ROLE && !e.selfDriven && !this.away(e) && this.eng.tasks.isFree(e));
    if (free.length) {
      for (const t of core.tasks.filter((x) => x.status === 'READY' && !x.assigneeId && x.kind !== 'review' && active(x.projectId))) {
        // Give the scheduler its turn first: where a project assigns automatically, this is only what it left over.
        if (now - Date.parse(t.updatedAt) < settle) continue;
        const who = this.candidates(t, free.filter((e) => this.sameComputer(e, t.projectId)));
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
      // (A spell of doing nothing stays "seen" for as long as it lasts, also while the employee is being left alone.)
      const spells = new Set(core.employees.filter((e) => !e.archived).map((e) => `idle:${e.id}:${core.runningSessionOf(e.id)?.activitySince ?? ''}`));
      // (And a wait stays "seen" for as long as it stands, also while the colleague is at work on it again.)
      const waits = new Set(core.sessions.filter((x) => !!x.waitingOn).map((x) => `waiting:${x.employeeId}:${x.waitingOn!.requestId ?? x.waitingOn!.taskId}`));
      const seen = this.state.seen.filter((k) => present.has(k) || (k.startsWith('question:') && openQuestions.has(k.slice('question:'.length))) || spells.has(k) || waits.has(k));
      const escalated = this.state.escalated.filter((id) => openQuestions.has(id));
      const gone = Object.keys(this.state.idle).filter((id) => core.employees.get(id)?.archived !== false);
      for (const id of gone) delete this.state.idle[id];
      if (seen.length !== this.state.seen.length || escalated.length !== this.state.escalated.length || gone.length) {
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
      visiting: null,
      idleBefore: {},
    };
    for (const i of fresh.filter((x) => x.kind === 'idle' && !!x.employeeId)) {
      const who = core.employees.get(i.employeeId)!;
      round.idleBefore[who.id] = this.state.idle[who.id] ?? null;
      this.state.idle[who.id] = { shownAt: round.startedAt, streak: this.idleStreak(who, boss) + 1 };
    }
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
      counts.idle ? `${counts.idle} idle` : '',
      counts.waiting ? `${counts.waiting} waiting for a colleague` : '',
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
        q.options.length ? `Options offered: ${q.options.slice(0, 8).map((o) => truncate(oneLine(String(o.label)), 80)).join(' | ')}` : '',
        q.parts.length > 1 ? `It has ${q.parts.length} parts; answer each: ${q.parts.map((p) => `"${p.question}"`).join(', ')}` : '',
      ].filter(Boolean);
      return `QUESTION ${q.id} from ${asker?.name ?? 'an employee'} (${[asker?.title, task?.key].filter(Boolean).join(', ')}): "${truncate(oneLine(q.text), 600)}" — waiting ${waited}${i.escalated ? ' — you escalated it to the boss' : ''}${extra.length ? `\n   ${extra.join('\n   ')}` : ''}`;
    }
    return `${KIND_LABEL[i.kind]} ${i.text}${i.kind === 'stalled' || i.kind === 'idle' || i.kind === 'waiting' ? '' : ` — for ${waited}`}`;
  }

  private teamLines(boss: Employee): string[] {
    const core = this.core;
    return core.employees
      .filter((e) => !e.archived && e.id !== boss.id && !this.away(e))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => {
        const s = core.runningSessionOf(e.id);
        const t = this.eng.tasks.currentTask(e.id);
        return `- ${e.name} (${e.title}) — ${s ? (ACTIVITY_LABEL[s.activity] ?? s.activity) : 'no session'}${t ? ` · ${t.key} "${truncate(t.title, 50)}"` : ' · no task'}${this.where(e)}`;
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
      ...(has('blocked') || has('stalled') ? ['- BLOCKED / STALLED: look_at the employee, then tell them what to do with tell_employee, or escalate_to_owner.'] : []),
      ...(has('unassigned') ? ['- UNASSIGNED: give it to the most suitable free person with assign_task.'] : []),
      ...(has('idle')
        ? ['- IDLE: look_at them. If their screen shows work that stopped half-way, or a question to whoever is at the keyboard, tell_employee what to do next (or escalate_to_owner if it is not yours to decide). If there is ready work they can take, assign_task; if what they were asked for clearly needs a follow-up, create_task and assign it. If they finished what they were asked and nothing is left, leave them be and say so in your summary.']
        : []),
      ...(has('waiting')
        ? ['- WAITING: someone cannot go on until a colleague has answered or finished, and that colleague is not at it. look_at the colleague, then tell_employee them what is wanted of them (answer the request with respond_to_request; pick the task up) — or tell the one who waits to carry on without it. escalate_to_owner if it is not yours to decide.']
        : []),
      ...(this.core.employees.find((e) => !e.archived && this.personal(e.hostId)) ? ['- People marked "on …\'s own computer" work on that member\'s own projects: they only take tasks of projects on that same computer, and nobody else takes those.'] : []),
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
      for (const [id, before] of Object.entries(r.idleBefore)) {
        if (before) this.state.idle[id] = before;
        else delete this.state.idle[id];
      }
    }
    const { foremanId: _f, keys: _k, delivered: _d, visiting: _v, idleBefore: _i, ...record } = r;
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
    const why = boss ? this.unavailable(boss) : 'The office has no foreman. Hire one (Team → Hire, role "Foreman") and give it a folder to run in.';
    const lastEnd = last ? Date.parse(last.finishedAt ?? last.startedAt) : null;
    let round: ForemanRound | null = null;
    if (this.round) {
      const { foremanId: _f, keys: _k, delivered: _d, visiting: _v, idleBefore: _i, ...record } = this.round;
      round = record;
    }
    return {
      settings: core.settings.foreman,
      foreman: boss ? { id: boss.id, name: boss.name, session: s?.status ?? null, activity: s?.activity ?? null } : null,
      otherForemen: core.employees.filter((e) => !e.archived && e.roleKey === FOREMAN_ROLE && e.id !== boss?.id).map((e) => e.name),
      visiting: this.round?.visiting ?? null,
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
    // Everyone in the office, on the office's machines and on members' own computers alike.
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

  /**
   * The foreman is with someone: it looked at them, answered them, gave them work or told them something. On the
   * record as an event (which is also what makes its character walk over); what was on anyone's screen is not in it.
   */
  private visit(boss: Employee, target: Employee, sessionId: string | null, action: 'look' | 'answer' | 'assign' | 'tell', extra: Record<string, unknown> = {}): void {
    const round = this.roundOf(boss);
    const summary = action === 'look' ? `${boss.name} looked at what ${target.name} is doing` : action === 'answer' ? `${boss.name} went over to ${target.name} with an answer` : action === 'assign' ? `${boss.name} gave ${target.name} work` : `${boss.name} told ${target.name} what to do next`;
    this.core.event({ type: 'foreman.visit', source: 'mcp', summary, employeeId: boss.id, sessionId, projectId: target.projectId, correlationId: round?.id ?? null, data: { fromEmployeeId: boss.id, toEmployeeId: target.id, roundId: round?.id ?? null, action, ...(action === 'look' ? {} : { quiet: true }), ...extra } });
    if (!round) return;
    round.visiting = target.id;
    if (!round.visited.includes(target.id)) round.visited.push(target.id);
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
      // A closed room: that somebody is there is for everyone to see; on what they work, what they have in hand and
      // what they asked is not — for the foreman as for the owners.
      if (this.closed(e.hostId)) {
        const owner = core.hosts.get(e.hostId!);
        lines.push(`- ${e.name} — ${e.title} · on ${owner?.memberName ?? owner?.name ?? 'a member'}'s own computer, whose room is closed: nothing there is yours to look at or direct`);
        continue;
      }
      const s = core.sessionOf(e.id);
      const live = s && (s.status === 'running' || s.status === 'starting');
      const task = this.eng.tasks.currentTask(e.id);
      const waiting = core.tasks.filter((t) => t.assigneeId === e.id && (t.status === 'READY' || t.status === 'BLOCKED' || t.status === 'REVIEW'));
      const q = core.questions.find((x) => x.employeeId === e.id && x.status === 'open' && x.channel !== 'system');
      const state = !s ? 'no session yet' : !live ? `no running session (${s.status}${s.exitReason ? `: ${truncate(s.exitReason, 60)}` : ''})` : `${ACTIVITY_LABEL[s.activity] ?? s.activity} for ${formatDuration(now - Date.parse(s.activitySince))}${s.activityDetail ? ` ("${truncate(oneLine(s.activityDetail), 70)}")` : ''}`;
      lines.push(
        `- ${e.name} — ${e.title} · ${core.projects.get(e.projectId)?.name ?? 'no project'} · ${state} · ${task ? `${task.key} [${task.status}] "${truncate(task.title, 60)}"${task.progress.percent != null ? ` ${task.progress.percent}%` : ''}` : 'no task in progress'}${this.where(e)}${waiting.length ? ` · also theirs: ${waiting.map((t) => `${t.key} [${t.status}]`).join(', ')}` : ''}${q ? ` · open ${q.kind === 'permission' || q.kind === 'trust_prompt' ? 'approval request (the boss decides)' : q.kind} ${q.id}: "${truncate(oneLine(q.text), 120)}"` : ''}`,
      );
    }
    lines.push('', 'Projects:');
    if (!projects.length) lines.push('- no projects yet');
    for (const p of projects) {
      if (this.closed(p.hostId)) {
        const owner = core.hosts.get(p.hostId!);
        lines.push(`- ${p.name} (on ${owner?.memberName ?? owner?.name ?? 'a member'}'s own computer, whose room is closed)`);
        continue;
      }
      const tasks = core.tasks.filter((t) => t.projectId === p.id && t.kind !== 'review');
      const owner = this.personal(p.hostId) ? core.hosts.get(p.hostId!) : undefined;
      lines.push(`- ${p.name} (${p.status}${p.policy.autoAssign ? ', assigns ready work automatically' : ', work is assigned by hand'}${owner ? `, on ${owner.memberName ?? owner.name}'s own computer: only employees there work on it` : ''}): ${BOARD.map((st) => `${st} ${tasks.filter((t) => t.status === st).length}`).join(' · ')}`);
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
    const lines: string[] = [`${target.name} — ${target.title} · ${core.projects.get(target.projectId)?.name ?? 'no project'}${this.where(target)}`];
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
      const text = plainScreen(screen.lines).map((l) => l.trimEnd());
      while (text.length && !text[text.length - 1]) text.pop();
      const tail = text.slice(-SCREEN_LINES).map((l) => redactSecrets(truncate(l, 220)));
      if (tail.length) {
        shown = true;
        lines.push('', `Their terminal screen, captured ${formatDuration(Math.max(0, now - Date.parse(screen.ts)))} ago (last ${tail.length} line${tail.length === 1 ? '' : 's'}):`, '```', ...tail, '```');
      }
    }
    if (!shown) lines.push('', live ? 'Their terminal screen: not available (no screen has been captured for this session yet).' : 'Their terminal screen: not available (no session is running).');
    this.visit(boss, target, sessionId, 'look', { screen: shown });
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
        if (this.closed(target.hostId)) return this.refuse(employee, 'look_at', this.closedSay(target.name), target.id);
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
        if (this.closed(core.employees.get(q.employeeId)?.hostId)) return this.refuse(employee, 'answer_question', this.closedSay(core.employees.get(q.employeeId)?.name ?? 'That employee'), q.id);
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
        const asker = core.employees.get(q.employeeId);
        if (asker) this.visit(employee, asker, null, 'answer');
        return `Answered ${core.employees.get(q.employeeId)?.name ?? 'the employee'}'s question on the owner's behalf. It is on the record as answered by you.`;
      },

      assign_task: async (a, { employee }) => {
        const task = this.eng.tasks.taskByKey(String(a.task));
        if (!task) return err(`No task "${a.task}". Use office_overview to see the board.`);
        const to = this.findEmployee(String(a.employee));
        if (!to) return err(`No employee matches "${a.employee}". Use office_overview to see who works here.`);
        if (to.roleKey === FOREMAN_ROLE) return err('A foreman supervises and does not take tasks. Assign it to someone who does the work.');
        if (task.assigneeId === to.id) return `${task.key} is already assigned to ${to.name}.`;
        if (this.closed(to.hostId)) return this.refuse(employee, 'assign_task', this.closedSay(to.name), task.id);
        if (!this.sameComputer(to, task.projectId)) return this.refuse(employee, 'assign_task', this.notSameComputer(to, task.projectId), task.id);
        this.eng.tasks.updateTask(task.id, { assigneeId: to.id }, actor(employee));
        this.did(employee, 'assigned');
        this.visit(employee, to, null, 'assign', { taskId: task.id });
        const next = task.status === 'READY' ? 'It is handed to them as soon as they are free.' : task.status === 'BACKLOG' ? (task.released ? 'It starts once its dependencies are done.' : 'It is not released yet: it starts once the owner releases it.') : `It is ${task.status}.`;
        return `${task.key} "${truncate(task.title, 80)}" is now assigned to ${to.name}. ${next}`;
      },

      create_task: async (a, { employee }) => {
        const project = this.findProject(String(a.project));
        if (!project) return err(`No project matches "${a.project}". Projects: ${core.projects.filter((p) => p.status !== 'archived').map((p) => p.name).join(', ') || 'none'}.`);
        if (project.status !== 'active') return err(`${project.name} is ${project.status}; the owner decides when work on it continues.`);
        // A project on a member's own computer whose room is closed is closed to the foreman as to everybody.
        const itsMember = this.eng.hosts.memberOfHost(project.hostId);
        if (itsMember && this.eng.hosts.isClosed(itsMember)) return err(`${project.name} is on a member's own computer, and that member has closed their room. Nothing is put there until it is open again.`);
        let assigneeId: string | null = null;
        if (a.assignee) {
          const to = this.findEmployee(String(a.assignee));
          if (!to) return err(`No employee matches "${a.assignee}".`);
          if (to.roleKey === FOREMAN_ROLE) return err('A foreman supervises and does not take tasks.');
          if (!this.sameComputer(to, project.id)) return this.refuse(employee, 'create_task', this.notSameComputer(to, project.id), project.id);
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
        if (assigneeId) this.visit(employee, core.employees.require(assigneeId), null, 'assign', { taskId: task.id });
        return `Created ${task.key} "${task.title}" in ${project.name}${assigneeId ? `, assigned to ${core.employees.get(assigneeId)?.name}` : ', unassigned'} (${task.status}).`;
      },

      tell_employee: async (a, { employee }) => {
        const to = this.findEmployee(String(a.employee));
        if (!to) return err(`No employee matches "${a.employee}". Use office_overview to see who works here.`);
        if (to.id === employee.id) return err('That is you.');
        if (to.roleKey === FOREMAN_ROLE) return err('That is another foreman, not someone you direct.');
        const message = String(a.message ?? '').trim();
        if (!message) return err('Say what they should do: "message" is empty.');
        if (this.closed(to.hostId)) return this.refuse(employee, 'tell_employee', this.closedSay(to.name), to.id);
        if (this.away(to)) return err(`${to.name} is on a member's own computer that is not in the office right now; nothing can be delivered there. Leave them until it is back.`);
        // The ordinary message queue: it reaches their session when they can read it, under the foreman's name, and is on the record.
        this.eng.comms.sendMessage({ from: { kind: 'employee', id: employee.id, name: `${employee.name} (the foreman)` }, toEmployeeId: to.id, body: truncate(message, 4000), taskId: this.eng.tasks.currentTask(to.id)?.id ?? null });
        this.did(employee, 'messaged');
        this.visit(employee, to, null, 'tell');
        return `Told ${to.name}. It is delivered to their session ${core.runningSessionOf(to.id) ? 'when they can read it' : this.eng.sessions.asleep(to.id) ? 'as soon as their session is up again (they were asleep and are being woken for it)' : 'once it runs (they have no running session right now)'}.`;
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

  private notSameComputer(to: Employee, projectId: string): string {
    const project = this.core.projects.get(projectId);
    return this.personal(to.hostId)
      ? `${to.name} works on a member's own computer and only takes tasks of projects on that computer; "${project?.name ?? 'that project'}" is not one of them.`
      : `"${project?.name ?? 'That project'}" is on a member's own computer; only employees on that computer can work on it, and ${to.name} is not one of them.`;
  }

  /** The foreman told someone something (the ordinary send_message tool): counted on the round. */
  noteMessage(employee: Employee): void {
    if (employee.roleKey === FOREMAN_ROLE) this.did(employee, 'messaged');
  }
}
