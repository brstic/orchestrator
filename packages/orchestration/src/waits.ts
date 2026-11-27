import type { AgentSession, CollabRequest, Employee, SessionWait, Task } from '@orchestrator/contracts';
import { ACTIVITY_LABEL, nowIso, truncate } from '@orchestrator/contracts';
import type { McpToolResult } from '@orchestrator/integrations';
import type { Engine } from './engine.ts';

/** A tool call that is being held open for someone who waits. */
interface Held {
  waiterId: string;
  sessionId: string;
  wait: SessionWait;
  resolve: (r: McpToolResult) => void;
  timer: NodeJS.Timeout | null;
  /** The awaited colleague has been seen with a running session during this call. */
  sawSession: boolean;
  /** Runs while the awaited colleague has no session: when it fires and there is still none, the wait is cut short. */
  gone: NodeJS.Timeout | null;
}

const err = (text: string): McpToolResult => ({ text, isError: true });
const LIVE = new Set(['running', 'starting', 'host_offline']);
/** Changes to these can end a wait or change whom it is on. */
const WATCHED = new Set(['task', 'session', 'employee', 'host']);
const ANSWERED: Record<string, string> = {
  incorporated: 'will do it as part of their current task',
  new_task: 'made it a separate task',
  needs_decision: 'has asked the boss to prioritise it',
  dependency: 'says it depends on other work',
  declined: 'declined it',
  resolved: 'has done it',
};

/**
 * Waiting for a colleague: an employee asks a teammate for something and needs it before going on, or waits until
 * a task somebody else has is finished. The tool call that asks is held open, the way `ask_boss` holds one for the
 * owner, and returns what happened: the answer, or how the task ended.
 *
 *   the answer comes / the task ends     → returned as the tool result
 *   the bound passes (`colleagueWaitMs`) → "not yet", and how to keep waiting; the wait stands, and what comes
 *                                          later reaches the session as a message
 *   the awaited colleague is paused,
 *   archived, unreachable, or their
 *   session stops                        → returned at once, saying so
 *   it would be waiting on oneself, in a
 *   circle, or across the line between
 *   the shared office and a member's
 *   own computer                         → refused before anything is held
 *
 * What a session waits for is on its own record (`AgentSession.waitingOn`): that is what the office shows, what the
 * sleeper and routines read, and what survives a restart of the office (the held call does not).
 */
export class Waits {
  private eng: Engine;
  /** By the id of the employee who waits: one held call each. */
  private held = new Map<string, Held>();
  /** Sessions whose wait stands without a call being held for it. */
  private standing = new Set<string>();
  private sweeping = false;
  private again = false;

  constructor(eng: Engine) {
    this.eng = eng;
    // Whatever changes a task, a session, an employee or a machine may end a wait: look whenever one does.
    eng.core.bus.on('entity', (kind) => {
      if (WATCHED.has(kind) && (this.held.size || this.standing.size)) this.sweep();
    });
    // (A session that could not be started for what is waiting is said in the feed, not in an entity.)
    eng.core.bus.on('event', (e) => {
      if (e.type === 'session.lost' && this.held.size) this.sweep();
    });
  }

  private get core() {
    return this.eng.core;
  }

  /** After a restart no call is being held any more; the waits themselves stand. */
  restore(): void {
    for (const s of this.core.sessions.filter((x) => !!x.waitingOn)) {
      s.waitingOn = LIVE.has(s.status) ? { ...s.waitingOn!, held: false } : null;
      this.core.sessions.put(s);
      if (s.waitingOn) this.standing.add(s.id);
    }
  }

  // ───────────────────────────── in words ─────────────────────────────

  /** Whom a wait is on right now. For a task that is whoever has it: its assignee, or its reviewer while it is in review. */
  awaited(w: SessionWait): Employee | undefined {
    if (w.requestId) return this.core.employees.get(this.core.collabs.get(w.requestId)?.toEmployeeId);
    const t = this.core.tasks.get(w.taskId);
    if (!t) return undefined;
    if (t.status === 'REVIEW') return this.core.employees.get(this.core.tasks.find((r) => r.reviewOf === t.id && r.status !== 'DONE')?.assigneeId);
    return this.core.employees.get(t.assigneeId);
  }

  /** "Sarah's answer", "Sarah to finish T-12": what a wait is for, to follow "waiting for". */
  words(w: SessionWait): string {
    const who = this.awaited(w);
    if (w.requestId) return `${who?.name ?? 'a colleague'}'s answer`;
    const key = this.core.tasks.get(w.taskId)?.key ?? 'a task';
    return who ? `${who.name} to finish ${key}` : `${key} to be finished`;
  }

  /** The caption under a waiting employee's name: "Waiting for Sarah (T-12)". */
  detail(w: SessionWait): string {
    const who = this.awaited(w);
    if (w.requestId) return `Waiting for ${who?.name ?? 'a colleague'}'s answer`;
    const t = this.core.tasks.get(w.taskId);
    const key = t?.key ?? 'a task';
    return who ? `Waiting for ${who.name} (${key})` : `Waiting for ${key}${t?.status === 'REVIEW' ? ' (in review)' : ''}`;
  }

  /** The wait of an employee's running session, if they are waiting for someone. */
  of(employeeId: string | null | undefined): SessionWait | null {
    return this.core.runningSessionOf(employeeId)?.waitingOn ?? null;
  }

  /** Is a call being held open right now for the answer to this request? */
  holding(requestId: string): boolean {
    return [...this.held.values()].some((h) => h.wait.requestId === requestId);
  }

  // ─────────────────────────── may one wait? ───────────────────────────

  /** Is this host a member's own computer? */
  private personal(hostId: string | null | undefined): boolean {
    return !!this.eng.hosts.memberOfHost(hostId);
  }

  /** Both in the shared office, or both on the same member's computer: work never crosses between the two. */
  private sameSide(a: Employee, b: Employee): boolean {
    return !(this.personal(a.hostId) || this.personal(b.hostId)) || a.hostId === b.hostId;
  }

  /** May this employee know about a task? Those of the shared office, or of the member's computer they are on themselves. */
  private canSee(e: Employee, t: Task): boolean {
    const projectHost = this.core.projects.get(t.projectId)?.hostId ?? null;
    return !(this.personal(e.hostId) || this.personal(projectHost)) || e.hostId === projectHost;
  }

  /** Who is (through calls held right now) waiting for whom, from `from` on, if that leads back to `waiter`. */
  private circle(waiter: Employee, from: Employee): string | null {
    const names: string[] = [];
    const seen = new Set<string>();
    let cur: Employee | undefined = from;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const h = this.held.get(cur.id);
      if (!h) return null;
      const next = this.awaited(h.wait);
      if (next?.id === waiter.id) {
        const c = h.wait.requestId ? this.core.collabs.get(h.wait.requestId) : undefined;
        const what = c ? `your answer to request ${c.id} ("${truncate(c.summary, 80)}")` : `you to finish ${this.core.tasks.get(h.wait.taskId)?.key ?? 'a task'}`;
        const chain = [...names.map((n, i) => `${n} is waiting for ${names[i + 1] ?? cur!.name}`), `${cur.name} is waiting for ${what}`].join(', and ');
        return `${chain}. Waiting for ${from.name} now would leave you ${names.length ? 'all' : 'both'} stuck. Deal with what is wanted from you first${c ? ' (respond_to_request)' : ''}, or carry on without waiting.`;
      }
      names.push(cur.name);
      cur = next;
    }
    return null;
  }

  /** Why this employee may not begin to wait for anything right now; null when they may. */
  private cannotWait(waiter: Employee): string | null {
    const mine = this.held.get(waiter.id);
    return mine ? `You are already waiting for ${this.words(mine.wait)} in another call. Wait for one thing at a time.` : null;
  }

  /**
   * Why `waiter` may not begin to wait for `target`, in words for the one who asked; null when they may.
   * `what`: an answer to a request, or the end of a task (which the target has).
   */
  cannotWaitFor(waiter: Employee, session: AgentSession, target: Employee, what: 'answer' | Task): string | null {
    const task = what === 'answer' ? null : what;
    const never = this.cannotWait(waiter);
    if (never) return never;
    if (target.id === waiter.id) return task ? `${task.key} is your own task: there is nobody to wait for.` : 'That is you: there is nobody to wait for.';
    if (target.archived) return `${target.name} no longer works here, so nothing will come from them.`;
    if (!this.sameSide(waiter, target)) {
      const host = this.personal(target.hostId) ? this.core.hosts.get(target.hostId!) : undefined;
      return `${host ? `${target.name} works on ${host.memberName ?? 'a member'}'s own computer` : `You work on a member's own computer and ${target.name} in the shared office`}. Work does not cross between the shared office and a member's own computer, so you cannot wait for them. Ask the boss (ask_boss) if you need something from there.`;
    }
    const s = this.core.runningSessionOf(target.id);
    if (s) {
      if (this.core.gateway.isPaused(s.id)) return `${target.name} is paused by the owner and will not ${task ? `work on ${task.key}` : 'answer'} until they are resumed.`;
      if (!task && !s.capabilities.mcp) return `${target.name}'s session has no office tools, so they cannot answer a request. Use send_message, or ask the boss.`;
    } else {
      const no = this.eng.sessions.cannotStart(target);
      if (no) return `${target.name} cannot be reached right now: ${no}.`;
      // A task that was handed over and whose session then went away: nothing will start it again by itself.
      if (task?.status === 'IN_PROGRESS' && !this.eng.tasks.isStarting(target.id)) {
        return `${target.name} has ${task.key} in progress but no running session${this.core.sessionOf(target.id)?.exitReason ? ` (${truncate(this.core.sessionOf(target.id)!.exitReason!, 100)})` : ''}, so nobody is working on it. Tell the boss (ask_boss) rather than wait.`;
      }
    }
    return this.circle(waiter, target);
  }

  // ─────────────────────────── what happened ───────────────────────────

  /** What the one who asked is told once a request has been answered. */
  private answerText(c: CollabRequest): string {
    const to = this.core.employees.get(c.toEmployeeId);
    let next = '';
    if (c.status === 'incorporated') {
      const t = this.core.tasks.get(c.responderTaskId);
      if (t && t.status !== 'DONE') next = ` It is part of ${t.key}: if you need the finished work and not only this answer, call wait_for_colleague with task "${t.key}".`;
    } else if (c.status === 'new_task') {
      const t = this.core.tasks.get(c.createdTaskId);
      if (t) next = ` It is ${t.key} on the board: to wait until it is finished, call wait_for_colleague with task "${t.key}".`;
    } else if (c.status === 'needs_decision') next = ' You get a message when the boss has decided. Carry on with what does not depend on it.';
    return `${to?.name ?? 'Your colleague'} answered your request "${truncate(c.summary, 120)}" — ${to?.name ?? 'they'} ${ANSWERED[c.status] ?? c.status}: ${c.response ?? ''}${next}`;
  }

  /** How a task ended, if it has: done, blocked, or gone from the board. Null while it is still on its way. */
  private taskEnd(taskId: string | null): McpToolResult | null {
    const t = this.core.tasks.get(taskId);
    if (!t) return err('The task you were waiting for was removed from the board, so it will not be finished.');
    const who = this.core.employees.get(t.assigneeId);
    const by = who ? ` (${who.name})` : '';
    if (t.status === 'DONE') {
      const byHand = /^Marked done manually/.test(t.history[t.history.length - 1]?.note ?? '');
      return {
        text: `${t.key} "${truncate(t.title, 100)}" is DONE${by}.${t.evidence.merge?.ok ? ` It is merged into ${t.evidence.merge.into}.` : ''}${byHand ? ' It was marked done by hand, not verified by the office.' : ''}${t.evidence.summary ? `\nTheir summary: ${truncate(t.evidence.summary, 1500)}` : ''}`,
      };
    }
    if (t.status === 'BLOCKED') {
      return { text: `${t.key} "${truncate(t.title, 100)}" is BLOCKED, not finished${by}: ${truncate(t.blockedReason ?? 'no reason recorded', 600)}. The boss has been told. Do not wait for it: carry on with what does not depend on it, or say what you need with ask_boss.` };
    }
    return null;
  }

  /** What the awaited colleague is doing, for "not yet". */
  private stateOf(who: Employee | undefined): string {
    if (!who) return '';
    const s = this.core.runningSessionOf(who.id);
    if (!s) return `${who.name} ${this.eng.sessions.asleep(who.id) ? 'was asleep and is being woken' : 'has no running session yet'}`;
    if (s.inTurn === false) return `${who.name} is between turns`;
    return `${who.name} is at work (${(ACTIVITY_LABEL[s.activity] ?? s.activity).toLowerCase()})`;
  }

  /** The bound passed: what the one who waits is told, and how to pick the wait up again. */
  private notYet(w: SessionWait): McpToolResult {
    const who = this.awaited(w);
    if (w.requestId) {
      const c = this.core.collabs.get(w.requestId)!;
      const sent = this.core.messages.find((m) => m.threadId === c.id && m.kind === 'collab_request');
      const reached = sent && sent.delivery.status !== 'queued' ? 'they have your request' : 'your request has not reached them yet';
      return {
        text: `${who?.name ?? 'Your colleague'} has not answered yet (request ${c.id}): ${reached}; ${this.stateOf(who)}. Do not guess the answer. Either carry on with work that does not depend on it, or call wait_for_colleague with request_id "${c.id}" to keep waiting. If they answer while you are working, the answer is delivered to you.`,
      };
    }
    const t = this.core.tasks.get(w.taskId)!;
    return {
      text: `${t.key} is not finished yet: it is ${t.status}${who ? `; ${this.stateOf(who)}` : t.status === 'REVIEW' ? ', waiting for the boss to review it' : ''}${t.progress.note ? `. Last progress report: ${truncate(t.progress.note, 160)}` : ''}. Either carry on with work that does not depend on it, or call wait_for_colleague with task "${t.key}" to keep waiting. When it ends you are told.`,
    };
  }

  // ───────────────────────────── waiting ─────────────────────────────

  /**
   * The `request_collaboration` / `request_help` tools with `wait`, and `wait_for_colleague` with a request id:
   * hold the call until the request is answered. Returns at once when it already was.
   */
  forRequest(waiter: Employee, session: AgentSession, c: CollabRequest, signal?: AbortSignal): Promise<McpToolResult> | McpToolResult {
    if (c.fromEmployeeId !== waiter.id) return err('That request is not yours to wait for.');
    if (c.status !== 'open') {
      // The answer may also be queued for the terminal; returning it here makes that redundant.
      this.eng.comms.responseReturnedByTool(c.id, waiter.id);
      if (session.waitingOn?.requestId === c.id) this.clear(session);
      return { text: this.answerText(c) };
    }
    const to = this.core.employees.get(c.toEmployeeId);
    const no = to ? this.cannotWaitFor(waiter, session, to, 'answer') : 'The colleague you asked no longer exists.';
    if (no) return err(`${no} Your request ${c.id} stays open; if an answer comes, it is delivered to you.`);
    if (!c.waited) {
      c.waited = true;
      this.core.put('collab', c);
    }
    return this.hold(waiter, session, { employeeId: c.toEmployeeId, requestId: c.id, taskId: null, since: c.createdAt, held: true }, signal);
  }

  /** `wait_for_colleague` with a request id: one of the caller's own requests, by id or the start of it. */
  findRequest(waiter: Employee, ref: string): CollabRequest | undefined {
    const mine = (c: CollabRequest | undefined) => (c && c.fromEmployeeId === waiter.id ? c : undefined);
    return mine(this.core.collabs.get(ref)) ?? (ref.length >= 4 ? mine(this.core.collabs.find((c) => c.id.startsWith(ref) && c.fromEmployeeId === waiter.id)) : undefined);
  }

  /** `wait_for_colleague` with a task: hold the call until the task is done, blocked or gone. Returns at once when it already is. */
  forTask(waiter: Employee, session: AgentSession, ref: string, signal?: AbortSignal): Promise<McpToolResult> | McpToolResult {
    const t = this.eng.tasks.taskByKey(ref, waiter.projectId);
    // (One answer for "no such task" and "not yours to see": what is on a member's own computer is not confirmed to others.)
    if (!t || !this.canSee(waiter, t)) return err(`No task "${ref}" that you can see. Use get_project_context to see the tasks of your project.`);
    const ended = this.taskEnd(t.id);
    if (ended) {
      if (session.waitingOn?.taskId === t.id) this.clear(session);
      return ended;
    }
    const wait: SessionWait = { employeeId: null, requestId: null, taskId: t.id, since: nowIso(), held: true };
    const who = this.awaited(wait);
    if (!who) {
      if (t.assigneeId === null || t.status !== 'REVIEW') return err(`${t.key} "${truncate(t.title, 100)}" is ${t.status} and nobody has it, so there is nobody to wait for. Look again later (get_project_context), or tell the boss what you need (ask_boss).`);
      // In review with no reviewer among the employees: it waits for the owner. Nobody in the office to wait for, and allowed.
      const never = this.cannotWait(waiter);
      if (never) return err(never);
    } else {
      const no = this.cannotWaitFor(waiter, session, who, t);
      if (no) return err(no);
      if (t.status === 'BACKLOG' && !t.released) return err(`${t.key} has not been released by the boss yet, so nobody is going to work on it for now. Tell the boss what you need (ask_boss) rather than wait.`);
    }
    wait.employeeId = who?.id ?? null;
    return this.hold(waiter, session, wait, signal);
  }

  /** `wait_for_colleague` with no arguments: the wait this session was in (also after a restart of the office). */
  resume(waiter: Employee, session: AgentSession, signal?: AbortSignal): Promise<McpToolResult> | McpToolResult {
    const w = session.waitingOn;
    if (!w) return err('You are not waiting for anything. Pass request_id (a request you sent) or task (a task key such as "T-12").');
    if (w.requestId) {
      const c = this.core.collabs.get(w.requestId);
      return c ? this.forRequest(waiter, session, c, signal) : err('The request you were waiting on no longer exists.');
    }
    return this.forTask(waiter, session, w.taskId ?? '', signal);
  }

  private hold(waiter: Employee, session: AgentSession, wait: SessionWait, signal?: AbortSignal): Promise<McpToolResult> {
    // The same wait picked up again keeps the moment it began.
    const before = session.waitingOn;
    const same = !!before && before.requestId === wait.requestId && before.taskId === wait.taskId;
    if (same) wait.since = before!.since;
    return new Promise((resolve) => {
      const h: Held = { waiterId: waiter.id, sessionId: session.id, wait, resolve, timer: null, sawSession: false, gone: null };
      h.timer = setTimeout(() => this.release(h, this.notYet(h.wait), true), this.core.timings.colleagueWaitMs);
      h.timer.unref?.();
      this.held.set(waiter.id, h);
      // The session gave up on the call (its own time limit, an interrupt): nobody is listening; the wait stands.
      const closed = () => this.release(h, err('The call was closed before an answer came.'), true);
      signal?.addEventListener('abort', closed, { once: true });
      if (!same) {
        this.core.event({ type: 'agent.waiting', source: 'mcp', summary: `${waiter.name} is waiting for ${this.words(wait)}`, employeeId: waiter.id, sessionId: session.id, taskId: wait.taskId, projectId: waiter.projectId, correlationId: wait.requestId ?? wait.taskId, data: { phase: 'began', toEmployeeId: wait.employeeId, requestId: wait.requestId, taskId: wait.taskId } });
      }
      this.mark(session, wait);
      // Things may have moved between the checks and here.
      if (signal?.aborted) closed();
      else this.sweep();
    });
  }

  /** Put what a session waits for on its record (null: nothing any more), and show it. */
  private mark(session: AgentSession, wait: SessionWait | null): void {
    const was = session.waitingOn ?? null;
    const changed = JSON.stringify(was) !== JSON.stringify(wait);
    session.waitingOn = wait;
    if (wait && !wait.held) this.standing.add(session.id);
    else this.standing.delete(session.id);
    const live = session.status === 'running' || session.status === 'starting';
    let show: [AgentSession['activity'], string | null] | null = null;
    if (wait?.held && live) show = ['waiting_input', this.detail(wait)];
    // The call returned: the session is thinking about what it was told (its next hook says what it really does).
    else if (was?.held && live && session.activity === 'waiting_input' && !this.core.gateway.isPaused(session.id)) show = ['thinking', null];
    // A wait that stood between turns is over: what is left is someone at the prompt.
    else if (!wait && was && live && session.inTurn === false && session.activity === 'waiting_input' && session.activityDetail?.startsWith('Waiting for ')) {
      const task = this.eng.tasks.currentTask(session.employeeId);
      show = task ? ['waiting_input', `Stopped while working on ${task.key}`] : ['idle', null];
    }
    // (`setActivity` stores and broadcasts the record only when what is shown changes.)
    const shown = !!show && (session.activity !== show[0] || session.activityDetail !== show[1]);
    if (show) this.eng.sessions.setActivity(session, show[0], show[1]);
    if (changed && !shown) this.core.put('session', session);
  }

  /** The session is no longer waiting for anything. */
  private clear(session: AgentSession): void {
    if (session.waitingOn && !this.held.has(session.employeeId ?? '')) this.mark(session, null);
  }

  /** End a held call. `stands`: the wait itself goes on without a call (the bound passed, or the call was closed). */
  private release(h: Held, result: McpToolResult, stands: boolean, why?: string): void {
    if (this.held.get(h.waiterId) !== h) return;
    this.held.delete(h.waiterId);
    if (h.timer) clearTimeout(h.timer);
    if (h.gone) clearTimeout(h.gone);
    const session = this.core.sessions.get(h.sessionId);
    const waiter = this.core.employees.get(h.waiterId);
    if (!stands && waiter) {
      this.core.event({ type: 'agent.waiting', source: 'server', summary: why ? `${waiter.name} stopped waiting for ${this.words(h.wait)}: ${truncate(why, 140)}` : `${waiter.name} has what they waited for (${this.words(h.wait)})`, employeeId: waiter.id, sessionId: h.sessionId, taskId: h.wait.taskId, projectId: waiter.projectId, correlationId: h.wait.requestId ?? h.wait.taskId, data: { phase: 'ended', cutShort: !!why, toEmployeeId: h.wait.employeeId, requestId: h.wait.requestId, taskId: h.wait.taskId, quiet: !why } });
    }
    if (session) this.mark(session, stands && LIVE.has(session.status) ? { ...h.wait, employeeId: this.awaited(h.wait)?.id ?? null, held: false } : null);
    h.resolve(result);
  }

  /** A request was answered (`Comms.respondToRequest`, after everything about the answer is on record). True when a held call took the answer. */
  answered(c: CollabRequest): boolean {
    const h = [...this.held.values()].find((x) => x.wait.requestId === c.id);
    if (h) this.release(h, { text: this.answerText(c) }, false);
    // A wait for it that stands without a call ends too: the answer travels to the session as the ordinary message.
    for (const id of this.standing) {
      const s = this.core.sessions.get(id);
      if (s?.waitingOn?.requestId === c.id) this.mark(s, null);
    }
    return !!h;
  }

  /** Why a held wait cannot go on, if it cannot: the awaited colleague is paused, gone, unreachable — or the task is nobody's. */
  private obstacle(h: Held): string | null {
    const w = h.wait;
    const who = this.awaited(w);
    const t = w.taskId ? this.core.tasks.get(w.taskId) : undefined;
    if (!who) {
      if (w.requestId) return 'The colleague you asked no longer exists.';
      return t && t.status !== 'REVIEW' ? `${t.key} is ${t.status} and nobody has it any more, so there is nobody to wait for.` : null;
    }
    if (who.id === h.waiterId) return t ? `${t.key} is yours now: there is nobody to wait for.` : 'The request is now with you.';
    if (who.archived) return `${who.name} no longer works here, so nothing will come from them.`;
    const s = this.core.runningSessionOf(who.id);
    if (s) {
      h.sawSession = true;
      if (h.gone) clearTimeout(h.gone);
      h.gone = null;
      return this.core.gateway.isPaused(s.id) ? `${who.name} was paused by the owner and will not ${t ? `work on ${t.key}` : 'answer'} until they are resumed.` : null;
    }
    // No session. Asleep, or not started yet, is fine: what is waiting for them starts it. Anything else may pass in a
    // moment — a session moving to the folder of a task, a machine whose link dropped and comes back, the office
    // itself going down — so it is given that moment, and only then is the wait cut short with what is the matter.
    const matter = (): string | null => {
      const no = this.eng.sessions.cannotStart(who);
      if (no) return `${who.name} cannot be reached any more: ${no}.`;
      const problem = w.requestId ? this.eng.comms.wakeProblem(who.id) : null;
      if (problem) return `${who.name}'s session could not be started: ${truncate(problem, 160)}.`;
      if (!h.sawSession || this.eng.tasks.isStarting(who.id)) return null;
      const last = this.core.sessionOf(who.id);
      return `${who.name}'s session stopped${last?.exitReason ? ` (${truncate(last.exitReason, 100)})` : ''} before ${t ? `${t.key} was finished` : 'they answered'}.`;
    };
    if (!h.gone && matter()) {
      h.gone = setTimeout(() => {
        h.gone = null;
        if (this.held.get(h.waiterId) !== h || this.core.runningSessionOf(who.id)) return;
        const why = matter();
        if (why) this.cut(h, why);
      }, this.core.timings.waitGoneGraceMs);
      h.gone.unref?.();
    }
    return null;
  }

  /** End a held call because waiting any longer makes no sense, saying why and what becomes of what was asked. */
  private cut(h: Held, why: string): void {
    const t = h.wait.taskId ? this.core.tasks.get(h.wait.taskId) : undefined;
    const left = h.wait.requestId ? `Your request ${h.wait.requestId} stays open; if an answer comes, it is delivered to you. ` : t ? `${t.key} is ${t.status}. ` : '';
    this.release(h, { text: `${why} ${left}Carry on with what does not depend on it, or tell the boss (ask_boss).` }, false, why);
  }

  private look(h: Held): void {
    const session = this.core.sessions.get(h.sessionId);
    // The one who waits is gone: there is nobody to tell.
    if (!session || !LIVE.has(session.status)) return this.release(h, err('Your session ended while you were waiting.'), false, 'their own session ended');
    // (A request's answer is handed over by `answered`, once everything about it is on record.)
    const ended = h.wait.taskId ? this.taskEnd(h.wait.taskId) : null;
    if (ended) return this.release(h, ended, false);
    const no = this.obstacle(h);
    if (no) return this.cut(h, no);
    // Whoever has the task may have changed (a handoff, a review).
    const who = this.awaited(h.wait)?.id ?? null;
    if (who !== h.wait.employeeId) {
      h.wait = { ...h.wait, employeeId: who };
      this.mark(session, h.wait);
    }
  }

  /** A wait that stands without a held call: when what it is for has ended, the session is told by a message. */
  private settle(sessionId: string): void {
    const s = this.core.sessions.get(sessionId);
    const w = s?.waitingOn;
    if (!s || !w || w.held) return void this.standing.delete(sessionId);
    const waiter = this.core.employees.get(s.employeeId);
    if (!waiter || waiter.archived || !LIVE.has(s.status)) return this.mark(s, null);
    const tell = (body: string) => this.eng.comms.sendMessage({ from: { kind: 'system', id: null, name: 'The office' }, toEmployeeId: waiter.id, body, kind: 'system', taskId: w.taskId });
    if (w.requestId) {
      const c = this.core.collabs.get(w.requestId);
      if (!c || c.status !== 'open') return this.mark(s, null);
      const to = this.core.employees.get(c.toEmployeeId);
      if (!to || to.archived) {
        this.mark(s, null);
        tell(`${to?.name ?? 'The colleague you asked'} no longer works here, so your request "${truncate(c.summary, 120)}" will not be answered.`);
      }
      return;
    }
    const ended = this.taskEnd(w.taskId);
    if (ended) {
      this.mark(s, null);
      tell(`About the task you were waiting for: ${ended.text}`);
      return;
    }
    const who = this.awaited(w)?.id ?? null;
    if (who !== w.employeeId) this.mark(s, { ...w, employeeId: who });
  }

  private sweep(): void {
    if (this.sweeping) {
      this.again = true;
      return;
    }
    this.sweeping = true;
    try {
      do {
        this.again = false;
        for (const h of [...this.held.values()]) this.look(h);
        for (const id of [...this.standing]) this.settle(id);
      } while (this.again);
    } catch (e) {
      this.core.log('error', `waits: ${(e as Error).stack}`);
    } finally {
      this.sweeping = false;
    }
  }
}
