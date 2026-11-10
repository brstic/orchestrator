import type { AgentSession, CollabRequest, Employee, Message, MessageKind, Notification, NotificationKind, Question, QuestionOption } from '@orchestrator/contracts';
import { correlationMarker, matchRole, newId, nowIso, truncate } from '@orchestrator/contracts';
import { xpForAssist } from '@orchestrator/game-systems';
import { EngineError } from './core.ts';
import type { Engine } from './engine.ts';
import { answerPrompt, messagePrompt } from './prompts.ts';

/**
 * Keys that select the affirmative option of Claude Code's workspace-trust
 * prompt, derived from the screen: find the highlighted option (❯) and the
 * "Yes…" option, move between them, confirm. Returns null if the screen does
 * not look like the prompt — we never press keys blind.
 */
export function trustPromptKeys(lines: string[]): string[] | null {
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  const options: Array<{ selected: boolean; yes: boolean }> = [];
  for (const line of plain) {
    const m = /^\s*(❯|>|›)?\s*(?:\d+\.\s*)?((?:Yes|No)\b.*)$/.exec(line);
    if (!m) continue;
    options.push({ selected: !!m[1], yes: /^Yes\b/.test(m[2]!) });
  }
  const from = options.findIndex((o) => o.selected);
  const to = options.findIndex((o) => o.yes);
  if (options.length < 2 || from < 0 || to < 0) return null;
  const keys: string[] = [];
  for (let i = 0; i < Math.abs(to - from); i++) keys.push(to > from ? 'Down' : 'Up');
  keys.push('Enter');
  return keys;
}

/** Something waiting to be typed (or hook-fed) into an employee's real session. */
export interface Delivery {
  id: string;
  employeeId: string;
  marker: 'TASK' | 'MSG' | 'ANSWER' | 'MEETING' | 'REVIEW' | 'REPORT' | 'RETRO' | 'ROUND';
  /** Id embedded in the correlation marker; a UserPromptSubmit hook carrying it confirms delivery. */
  markerId: string;
  ref: { kind: 'task' | 'message' | 'question' | 'meeting' | 'report' | 'retro' | 'round'; id: string };
  text: string;
  createdAt: number;
  attempts: number;
  sentAt: number | null;
  via: 'terminal_paste' | 'stop_hook' | 'sdk' | null;
  /** Stop-hook request this delivery rode on, until the host settles it. */
  stopRequestId: string | null;
  /** Start the employee's session for this if they have none (a routine that is due), as talking to them does. */
  wake?: boolean;
}

interface HookPending {
  hostId: string;
  requestId: string;
  kind: 'permission' | 'ask_user';
  toolInput: any;
}

/**
 * Questions, approvals, messages, collaboration requests, notifications and
 * the delivery queue that carries Orchestrator's words into real sessions.
 *
 * Nothing here reports success early: a delivery is `sent` when it was handed
 * to the runtime and `confirmed` only when the runtime acknowledged it.
 */
export class Comms {
  private eng: Engine;
  private queue = new Map<string, Delivery[]>();
  private inflight = new Map<string, Delivery>();
  private pumpTimers = new Map<string, { timer: NodeJS.Timeout; due: number }>();
  private hookPending = new Map<string, HookPending>();
  private requestToQuestion = new Map<string, string>();
  private waiters = new Map<string, Set<(q: Question) => void>>();
  private stopBatches = new Map<string, Delivery[]>();
  /** Per employee: when the office last tried to start their session for something waiting, and what went wrong if it did. */
  private wakes = new Map<string, { at: number; problem: string | null; running: boolean }>();

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  /** Rebuild the in-memory queue after a restart from persisted delivery states. */
  restore(): void {
    for (const m of this.core.messages.filter((x) => x.delivery.status === 'queued')) this.enqueueMessage(m, false);
    for (const q of this.core.questions.filter((x) => x.status === 'answered' && x.channel === 'mcp_tool' && !!x.employeeId)) this.enqueueAnswer(q, false);
    // Hook-held questions cannot survive a restart: the hook connection is gone.
    for (const q of this.core.questions.filter((x) => x.status === 'open' && (x.channel === 'permission_hook' || x.channel === 'ask_user_question_hook'))) {
      this.supersede(q.id, 'Orchestrator restarted while this request was pending; Claude Code falls back to its own prompt in the terminal.');
    }
  }

  // ───────────────────────── notifications ─────────────────────────

  notify(n: {
    kind: NotificationKind;
    severity: Notification['severity'];
    title: string;
    body?: string;
    employeeId?: string | null;
    sessionId?: string | null;
    taskId?: string | null;
    projectId?: string | null;
    questionId?: string | null;
    hostId?: string | null;
  }): Notification {
    const note: Notification = {
      id: newId(),
      kind: n.kind,
      severity: n.severity,
      title: n.title,
      body: n.body ?? '',
      employeeId: n.employeeId ?? null,
      sessionId: n.sessionId ?? null,
      taskId: n.taskId ?? null,
      projectId: n.projectId ?? null,
      questionId: n.questionId ?? null,
      hostId: n.hostId ?? null,
      createdAt: nowIso(),
      readAt: null,
      resolvedAt: null,
    };
    return this.core.put('notification', note);
  }

  private lastAlert = new Map<string, number>();

  /**
   * A security issue for the owner's queue: an event on the record and a notification.
   * `key` identifies the kind of incident, so a repeating one is reported once per ten minutes.
   */
  securityAlert(a: { key: string; title: string; body: string; severity?: Notification['severity']; employeeId?: string | null; sessionId?: string | null; hostId?: string | null; projectId?: string | null; data?: Record<string, unknown> }): boolean {
    const last = this.lastAlert.get(a.key) ?? 0;
    if (Date.now() - last < 10 * 60_000) return false;
    if (this.lastAlert.size > 500) this.lastAlert.clear();
    this.lastAlert.set(a.key, Date.now());
    this.core.event({ type: 'security.alert', source: 'server', summary: a.title, employeeId: a.employeeId ?? null, sessionId: a.sessionId ?? null, hostId: a.hostId ?? null, projectId: a.projectId ?? null, data: { detail: a.body, ...(a.data ?? {}) } });
    this.notify({ kind: 'security', severity: a.severity ?? 'warning', title: a.title, body: a.body, employeeId: a.employeeId ?? null, sessionId: a.sessionId ?? null, hostId: a.hostId ?? null, projectId: a.projectId ?? null });
    return true;
  }

  resolveNotifications(match: (n: Notification) => boolean): void {
    for (const n of this.core.notifications.filter((x) => !x.resolvedAt && match(x))) {
      n.resolvedAt = nowIso();
      this.core.put('notification', n);
    }
  }

  markRead(ids: string[] | 'all'): void {
    for (const n of this.core.notifications.filter((x) => !x.readAt && (ids === 'all' || ids.includes(x.id)))) {
      n.readAt = nowIso();
      this.core.put('notification', n);
    }
  }

  /** Keep the notification table from growing without bound. */
  prune(): void {
    const resolved = this.core.notifications.filter((n) => !!n.resolvedAt).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const n of resolved.slice(300)) this.core.remove('notification', n.id);
  }

  // ─────────────────────────── questions ───────────────────────────

  createQuestion(q: {
    kind: Question['kind'];
    channel: Question['channel'];
    employee: Employee | null;
    session: AgentSession | null;
    text: string;
    context?: string;
    why?: string;
    options?: QuestionOption[];
    tool?: Question['tool'];
    parts?: Question['parts'];
    taskId?: string | null;
    projectId?: string | null;
    quietEvent?: boolean;
  }): Question {
    const task = q.employee ? this.eng.tasks.currentTask(q.employee.id) : undefined;
    const question: Question = {
      id: newId(),
      kind: q.kind,
      channel: q.channel,
      employeeId: q.employee?.id ?? null,
      sessionId: q.session?.id ?? null,
      taskId: q.taskId ?? task?.id ?? null,
      projectId: q.projectId ?? task?.projectId ?? q.employee?.projectId ?? null,
      text: q.text,
      context: q.context ?? '',
      why: q.why ?? '',
      options: q.options ?? [],
      tool: q.tool ?? null,
      parts: q.parts ?? [],
      answers: null,
      status: 'open',
      answer: null,
      decision: null,
      createdAt: nowIso(),
      answeredAt: null,
      deliveredAt: null,
      confirmedAt: null,
      deliveryDetail: null,
    };
    // Asked before in this project? The earlier answer is shown with it; the question stays open for a person.
    const answeredBefore = this.eng.improver.capture.repeatedQuestion(question);
    this.core.put('question', question);
    if (question.taskId && q.channel !== 'system' && q.kind !== 'permission' && q.kind !== 'trust_prompt') {
      const t = this.core.tasks.get(question.taskId);
      if (t) {
        t.friction.questions++;
        this.core.put('task', t);
      }
    }
    const who = q.employee?.name ?? 'Orchestrator';
    const isPermission = q.kind === 'permission';
    this.notify({
      kind: isPermission ? 'permission' : q.kind === 'merge_conflict' ? 'merge_conflict' : 'question',
      severity: 'warning',
      title: isPermission ? `${who} needs approval` : `${who} needs a decision`,
      body: `${truncate(q.text, 240)}${answeredBefore ? `\n${answeredBefore}` : ''}`,
      employeeId: question.employeeId,
      sessionId: question.sessionId,
      taskId: question.taskId,
      projectId: question.projectId,
      questionId: question.id,
    });
    if (!q.quietEvent) {
      this.core.event({
        type: 'agent.question',
        source: q.channel === 'mcp_tool' ? 'mcp' : q.channel === 'system' ? 'server' : 'hook',
        summary: `${who} asked: ${truncate(q.text, 140)}`,
        employeeId: question.employeeId,
        sessionId: question.sessionId,
        taskId: question.taskId,
        projectId: question.projectId,
        correlationId: question.id,
        data: { questionId: question.id, kind: q.kind, channel: q.channel },
      });
    }
    return question;
  }

  /** A blocking hook is being held open on a host until this question is answered. */
  holdHook(question: Question, pending: HookPending): void {
    this.hookPending.set(question.id, pending);
    this.requestToQuestion.set(pending.requestId, question.id);
  }

  private setStatus(q: Question, status: Question['status'], detail?: string): void {
    q.status = status;
    if (detail !== undefined) q.deliveryDetail = detail;
    if (status === 'delivered') q.deliveredAt = nowIso();
    if (status === 'confirmed') {
      q.confirmedAt = nowIso();
      q.deliveredAt = q.deliveredAt ?? q.confirmedAt;
    }
    this.core.put('question', q);
    if (status === 'delivered' || status === 'confirmed' || status === 'superseded' || status === 'failed') {
      this.resolveNotifications((n) => n.questionId === q.id);
    }
    if (status === 'delivered') {
      this.core.event({
        type: 'agent.question_delivered',
        source: 'server',
        summary: `${this.core.employees.get(q.employeeId)?.name ?? 'Employee'} received ${q.answeredBy?.kind === 'foreman' ? `${q.answeredBy.name}'s (the foreman's)` : "the boss's"} ${q.kind === 'permission' ? 'decision' : 'answer'}`,
        employeeId: q.employeeId,
        sessionId: q.sessionId,
        taskId: q.taskId,
        projectId: q.projectId,
        correlationId: q.id,
        data: { questionId: q.id, via: q.channel, detail: q.deliveryDetail },
      });
    }
  }

  supersede(questionId: string, detail: string): void {
    const q = this.core.questions.get(questionId);
    if (!q || q.status === 'confirmed' || q.status === 'superseded' || q.status === 'failed') return;
    const pending = this.hookPending.get(questionId);
    if (pending) {
      this.requestToQuestion.delete(pending.requestId);
      this.hookPending.delete(questionId);
    }
    this.setStatus(q, 'superseded', detail);
    this.wake(q);
  }

  private wake(q: Question): void {
    const set = this.waiters.get(q.id);
    if (!set) return;
    this.waiters.delete(q.id);
    for (const fn of set) fn(q);
  }

  /** Used by the ask_boss tool: resolves when the question is answered, or null on timeout. */
  waitForAnswer(questionId: string, timeoutMs: number): Promise<Question | null> {
    const q = this.core.questions.get(questionId);
    if (!q) return Promise.resolve(null);
    if (q.status !== 'open') return Promise.resolve(q);
    return new Promise((resolve) => {
      let set = this.waiters.get(questionId);
      if (!set) this.waiters.set(questionId, (set = new Set()));
      const fn = (answered: Question) => {
        clearTimeout(timer);
        resolve(answered);
      };
      const timer = setTimeout(() => {
        set!.delete(fn);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      set.add(fn);
    });
  }

  hasWaiter(questionId: string): boolean {
    return (this.waiters.get(questionId)?.size ?? 0) > 0;
  }

  /** The tool call that was waiting returned the answer to the agent. */
  answerReturnedByTool(questionId: string): void {
    const q = this.core.questions.get(questionId);
    if (q && q.status === 'answered') this.setStatus(q, 'delivered', 'Returned as the result of the ask_boss tool call');
  }

  /**
   * The owner's reply to a question or approval — or, for an employee's question only, a foreman's
   * reply on the owner's behalf (`by`). A permission request is never decided by anyone but the owner.
   */
  async answer(questionId: string, input: { answer?: string | null; decision?: 'allow' | 'deny' | null; answers?: Record<string, string> | null }, actor = 'owner', by: { kind: 'foreman'; id: string; name: string } | null = null): Promise<Question> {
    const q = this.core.questions.require(questionId);
    if (by && q.kind !== 'question') throw new EngineError('Only the owner can decide this.', 403);
    if (q.status !== 'open') throw new EngineError(`this ${q.kind === 'permission' ? 'request' : 'question'} is no longer open (${q.status})`, 409);
    const employee = this.core.employees.get(q.employeeId);
    if (q.kind === 'permission') {
      if (input.decision !== 'allow' && input.decision !== 'deny') throw new EngineError('a permission request needs decision "allow" or "deny"');
    } else if (q.parts.length) {
      for (const part of q.parts) if (!input.answers?.[part.question]) throw new EngineError(`missing answer for: ${part.question}`);
    } else if (!input.answer?.trim()) throw new EngineError('an answer is required');

    q.answer = input.answer?.trim() ?? (q.parts.length ? Object.values(input.answers ?? {}).join('; ') : null);
    q.answers = input.answers ?? null;
    q.decision = input.decision ?? null;
    q.answeredAt = nowIso();
    q.status = 'answered';
    if (by) q.answeredBy = by;
    this.core.put('question', q);
    this.core.audit(actor, q.kind === 'permission' ? 'approval.decide' : 'question.answer', q.id, { decision: q.decision, employee: employee?.name, ...(by ? { onBehalfOfOwner: true } : {}) });
    this.core.company.questionsAnswered++;
    this.core.saveCompany();
    if (q.kind === 'permission') {
      if (q.decision === 'deny' && q.taskId) {
        const t = this.core.tasks.get(q.taskId);
        if (t) {
          t.friction.denials++;
          this.core.put('task', t);
        }
      }
      // A denial with a note says what should have been known: kept as a lesson candidate.
      if (q.decision === 'deny') this.eng.improver.capture.onDenied(q);
      // Each decision is evidence about what the owner is comfortable pre-approving.
      this.eng.improver.scheduleAnalyze();
    } else if (!by) this.eng.improver.captureOwnerAnswer(q); // only the owner's own answers become "decided by the boss" knowledge
    this.core.event({
      type: q.kind === 'permission' ? 'agent.permission_decided' : 'agent.question_answered',
      source: by ? 'mcp' : 'owner',
      summary:
        q.kind === 'permission'
          ? `Boss ${q.decision === 'allow' ? 'approved' : 'denied'} ${employee?.name ?? 'employee'}'s request`
          : `${by ? `${by.name} (foreman)` : 'Boss'} answered ${employee?.name ?? 'employee'}: ${truncate(q.answer ?? '', 100)}`,
      employeeId: q.employeeId,
      sessionId: q.sessionId,
      taskId: q.taskId,
      projectId: q.projectId,
      correlationId: q.id,
      data: { questionId: q.id, decision: q.decision, ...(by ? { answeredBy: by } : {}) },
    });

    switch (q.channel) {
      case 'permission_hook': {
        const pending = this.hookPending.get(q.id);
        if (!pending) {
          this.setStatus(q, 'failed', 'The permission hook is no longer waiting; answer the prompt in the terminal instead.');
          break;
        }
        const decision = q.decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: q.answer || 'Denied by the boss in Orchestrator.' };
        const ok = this.core.agents.respondHook(pending.hostId, pending.requestId, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
        if (!ok) this.setStatus(q, 'failed', 'The host is offline; the decision could not be delivered.');
        break;
      }
      case 'ask_user_question_hook': {
        const pending = this.hookPending.get(q.id);
        if (!pending) {
          this.setStatus(q, 'failed', 'Claude Code is no longer waiting on this question; answer it in the terminal instead.');
          break;
        }
        const answers = q.answers ?? (q.parts[0] ? { [q.parts[0].question]: q.answer ?? '' } : {});
        const ok = this.core.agents.respondHook(pending.hostId, pending.requestId, {
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: by ? `Answered by ${by.name} (the foreman) on the boss's behalf` : 'Answered by the boss in Orchestrator', updatedInput: { ...(pending.toolInput ?? {}), answers } },
        });
        if (!ok) this.setStatus(q, 'failed', 'The host is offline; the answer could not be delivered.');
        break;
      }
      case 'mcp_tool':
        if (this.hasWaiter(q.id)) this.wake(q);
        else if (q.employeeId) this.enqueueAnswer(q, true);
        else this.setStatus(q, 'failed', 'No session to deliver the answer to.');
        break;
      case 'terminal': {
        // e.g. the workspace trust prompt: the answer is a keypress in the real terminal.
        const session = this.core.sessions.get(q.sessionId);
        if (!session || !this.core.agents.isOnline(session.hostId)) {
          this.setStatus(q, 'failed', 'The session is not reachable.');
          break;
        }
        if (q.kind === 'trust_prompt' && /^(trust|yes)/i.test(q.answer ?? '')) {
          try {
            // Work out the keystrokes from what the prompt actually shows right now: the
            // default selection differs between Claude Code versions (it can be "No, exit").
            const keys = trustPromptKeys(this.core.gateway.screens.get(session.id)?.lines ?? []);
            if (!keys) {
              this.setStatus(q, 'failed', 'Could not read the trust prompt on screen; open the workstation and answer it in the terminal.');
              break;
            }
            await this.core.agents.rpc(session.hostId, { method: 'session.keys', params: { sessionId: session.id, keys } });
            this.setStatus(q, 'delivered', `Selected "Yes" on the trust prompt in the terminal (${keys.join(' ')})`);
          } catch (e) {
            this.setStatus(q, 'failed', (e as Error).message);
          }
        } else {
          this.setStatus(q, 'superseded', 'Left for the owner to handle in the terminal.');
        }
        break;
      }
      case 'system':
        await this.eng.onSystemAnswer(q);
        if (q.status === 'answered') this.setStatus(q, 'confirmed', 'Handled by Orchestrator');
        break;
    }
    return q;
  }

  /** A host told us what became of a hook we were holding open. */
  hookSettled(requestId: string, outcome: 'delivered' | 'abandoned', detail?: string): void {
    const batch = this.stopBatches.get(requestId);
    if (batch) {
      this.stopBatches.delete(requestId);
      for (const d of batch) {
        if (outcome === 'delivered') this.markConfirmed(d, 'Fed to the agent as Stop-hook feedback');
        else this.requeue(d);
      }
      return;
    }
    const qid = this.requestToQuestion.get(requestId);
    if (!qid) return;
    this.requestToQuestion.delete(requestId);
    this.hookPending.delete(qid);
    const q = this.core.questions.get(qid);
    if (!q) return;
    if (outcome === 'delivered' && q.status === 'answered') {
      this.setStatus(q, 'delivered', q.channel === 'permission_hook' ? 'Decision written to the PermissionRequest hook' : 'Answer supplied to AskUserQuestion through the hook');
    } else if (q.status === 'open' || q.status === 'answered') {
      this.setStatus(q, 'superseded', detail ?? 'Claude Code stopped waiting; the prompt is now in the terminal.');
      const emp = this.core.employees.get(q.employeeId);
      if (q.kind === 'permission') {
        this.notify({
          kind: 'permission',
          severity: 'warning',
          title: `${emp?.name ?? 'Employee'} is waiting at a terminal prompt`,
          body: 'The request was not answered in time, so Claude Code is showing its own permission prompt. Open the workstation to answer it.',
          employeeId: q.employeeId,
          sessionId: q.sessionId,
        });
      }
    }
  }

  /** Real evidence that the runtime acted on our answer (e.g. the approved tool actually ran). */
  confirmBySignal(sessionId: string, signal: { tool?: string | null; orchestratorTool?: string | null; sessionStarted?: boolean }): void {
    for (const q of this.core.questions.filter((x) => x.sessionId === sessionId && x.status === 'delivered')) {
      if (q.channel === 'permission_hook' && signal.tool && q.tool?.name === signal.tool) this.setStatus(q, 'confirmed', q.decision === 'deny' ? 'Claude Code reported the denial to the agent' : 'The approved tool ran');
      else if (q.channel === 'ask_user_question_hook' && signal.tool === 'AskUserQuestion') this.setStatus(q, 'confirmed', 'AskUserQuestion completed with the supplied answer');
      else if (q.channel === 'mcp_tool' && (signal.orchestratorTool === 'ask_boss' || signal.orchestratorTool === 'wait_for_answer')) this.setStatus(q, 'confirmed', 'The tool result reached the agent');
      else if (q.channel === 'terminal' && signal.sessionStarted) this.setStatus(q, 'confirmed', 'The session started after the prompt was accepted');
    }
  }

  /** A session ended: nothing can be delivered to it any more. */
  sessionEnded(sessionId: string): void {
    for (const q of this.core.questions.filter((x) => x.sessionId === sessionId && (x.status === 'open' || x.status === 'answered') && x.channel !== 'mcp_tool' && x.channel !== 'system')) {
      this.supersede(q.id, 'The session ended before this was resolved.');
    }
  }

  // ─────────────────────────── messages ────────────────────────────

  sendMessage(input: { from: Message['from']; toEmployeeId: string; body: string; kind?: MessageKind; taskId?: string | null; threadId?: string | null; routineId?: string | null }): Message {
    const to = this.core.employees.require(input.toEmployeeId);
    const msg: Message = {
      id: newId(),
      kind: input.kind ?? 'chat',
      from: input.from,
      toEmployeeId: to.id,
      body: input.body,
      taskId: input.taskId ?? null,
      threadId: input.threadId ?? null,
      delivery: { status: 'queued', via: null, ts: nowIso(), detail: null },
      createdAt: nowIso(),
      readAt: null,
      ...(input.routineId ? { routineId: input.routineId } : {}),
    };
    this.core.put('message', msg);
    this.core.event({
      type: 'agent.message',
      source: input.from.kind === 'owner' ? 'owner' : input.from.kind === 'employee' ? 'mcp' : 'server',
      summary: `${input.from.name} → ${to.name}: ${truncate(input.body, 120)}`,
      employeeId: input.from.kind === 'employee' ? input.from.id : to.id,
      taskId: msg.taskId,
      projectId: to.projectId,
      correlationId: msg.threadId ?? msg.id,
      data: { messageId: msg.id, toEmployeeId: to.id, fromEmployeeId: input.from.kind === 'employee' ? input.from.id : null, kind: msg.kind, ...(msg.routineId ? { routineId: msg.routineId } : {}) },
    });
    this.enqueueMessage(msg, true);
    // A message that reads as a standing rule ("don't…", "from now on…") is kept as a lesson candidate.
    this.eng.improver.capture.onMessage(msg);
    return msg;
  }

  private enqueueMessage(msg: Message, pump: boolean): void {
    const collab = msg.threadId ? this.core.collabs.get(msg.threadId) : undefined;
    this.enqueue(
      {
        id: newId(),
        employeeId: msg.toEmployeeId,
        marker: 'MSG',
        markerId: msg.id,
        ref: { kind: 'message', id: msg.id },
        text: messagePrompt(msg, collab),
        createdAt: Date.now(),
        attempts: 0,
        sentAt: null,
        via: null,
        stopRequestId: null,
        wake: !!msg.routineId,
      },
      pump,
    );
  }

  private enqueueAnswer(q: Question, pump: boolean): void {
    this.enqueue(
      {
        id: newId(),
        employeeId: q.employeeId!,
        marker: 'ANSWER',
        markerId: q.id,
        ref: { kind: 'question', id: q.id },
        text: answerPrompt(q),
        createdAt: Date.now(),
        attempts: 0,
        sentAt: null,
        via: null,
        stopRequestId: null,
      },
      pump,
    );
  }

  /** Messages an employee can pull with the check_messages tool. */
  pullMessages(employeeId: string): Message[] {
    const pending = this.core.messages.filter((m) => m.toEmployeeId === employeeId && !m.readAt).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    for (const m of pending) {
      m.readAt = nowIso();
      if (m.delivery.status === 'queued') {
        m.delivery = { status: 'confirmed', via: 'mcp_pull', ts: nowIso(), detail: 'Read by the agent with check_messages' };
        this.dropQueued((d) => d.ref.kind === 'message' && d.ref.id === m.id);
      }
      this.core.put('message', m);
    }
    return pending;
  }

  // ───────────────────────── collaboration ─────────────────────────

  /** Resolve "Alex" or "backend" to a teammate. */
  resolveTeammate(from: Employee, to: string): Employee | undefined {
    const byName = this.core.employeeByName(to);
    if (byName && byName.id !== from.id) return byName;
    const role = matchRole(to);
    if (!role) return undefined;
    const candidates = this.core.employees.filter((e) => !e.archived && e.id !== from.id && e.roleKey === role.key);
    const sameProject = candidates.filter((e) => e.projectId && e.projectId === from.projectId);
    const pool = sameProject.length ? sameProject : candidates;
    return pool.find((e) => !!this.core.runningSessionOf(e.id)) ?? pool[0];
  }

  requestCollaboration(from: Employee, toRef: string, summary: string, detail: string): CollabRequest {
    const to = this.resolveTeammate(from, toRef);
    if (!to) throw new EngineError(`no teammate matches "${toRef}". Use get_team to see who is available, or ask_boss.`);
    const task = this.eng.tasks.currentTask(from.id);
    const collab: CollabRequest = {
      id: newId().slice(0, 8),
      fromEmployeeId: from.id,
      toEmployeeId: to.id,
      projectId: from.projectId,
      taskId: task?.id ?? null,
      summary,
      detail,
      status: 'open',
      response: null,
      responderTaskId: null,
      createdAt: nowIso(),
      resolvedAt: null,
    };
    this.core.put('collab', collab);
    this.core.event({
      type: 'agent.collaboration_requested',
      source: 'mcp',
      summary: `${from.name} asked ${to.name}: ${truncate(summary, 120)}`,
      employeeId: from.id,
      taskId: collab.taskId,
      projectId: collab.projectId,
      correlationId: collab.id,
      data: { collabId: collab.id, fromEmployeeId: from.id, toEmployeeId: to.id },
    });
    this.sendMessage({ from: { kind: 'employee', id: from.id, name: `${from.name} (${from.title})` }, toEmployeeId: to.id, body: `${summary}\n${detail}`.trim(), kind: 'collab_request', taskId: collab.taskId, threadId: collab.id });
    return collab;
  }

  respondToRequest(responder: Employee, requestId: string, action: CollabRequest['status'], note: string): CollabRequest {
    const collab = this.core.collabs.get(requestId) ?? this.core.collabs.find((c) => c.id.startsWith(requestId));
    if (!collab) throw new EngineError(`no collaboration request "${requestId}"`);
    if (collab.toEmployeeId !== responder.id) throw new EngineError('that request was not addressed to you');
    if (collab.status !== 'open') throw new EngineError(`that request was already answered (${collab.status})`);
    const requester = this.core.employees.require(collab.fromEmployeeId);
    collab.status = action;
    collab.response = note;
    collab.resolvedAt = nowIso();
    collab.responderTaskId = this.eng.tasks.currentTask(responder.id)?.id ?? null;
    this.core.put('collab', collab);
    this.core.event({
      type: 'agent.collaboration_resolved',
      source: 'mcp',
      summary: `${responder.name} answered ${requester.name}'s request: ${action.replace('_', ' ')}`,
      employeeId: responder.id,
      taskId: collab.responderTaskId,
      projectId: collab.projectId,
      correlationId: collab.id,
      data: { collabId: collab.id, action, fromEmployeeId: requester.id, toEmployeeId: responder.id },
    });
    const outcome: Record<string, string> = {
      incorporated: 'will handle it as part of their current task',
      new_task: 'says it should be a separate task (created on the board)',
      needs_decision: 'has asked the boss to prioritise it',
      dependency: 'reports that it depends on other work',
      declined: 'declined it',
    };
    this.sendMessage({
      from: { kind: 'employee', id: responder.id, name: `${responder.name} (${responder.title})` },
      toEmployeeId: requester.id,
      body: `Re: "${collab.summary}" — ${responder.name} ${outcome[action] ?? action}. ${note}`,
      kind: 'chat',
      taskId: collab.taskId,
      // The answer belongs to the same thread as the request it answers.
      threadId: collab.id,
    });
    if (action === 'new_task' && collab.projectId) {
      const project = this.core.projects.get(collab.projectId);
      if (project) {
        this.eng.tasks.createTask(
          {
            projectId: project.id,
            title: truncate(collab.summary, 90),
            description: `Requested by ${requester.name} from ${responder.name}.\n\n${collab.detail}\n\n${responder.name}'s note: ${note}`,
            roleHint: responder.roleKey,
            assigneeId: responder.id,
            kind: 'feature',
            released: project.policy.autoAssign,
          },
          `employee:${responder.name}`,
        );
      }
    }
    if (action === 'needs_decision') {
      this.createQuestion({
        kind: 'priority',
        channel: 'system',
        employee: responder,
        session: this.core.runningSessionOf(responder.id) ?? null,
        text: `${requester.name} asked ${responder.name} for: ${collab.summary}. ${responder.name} needs you to prioritise it.`,
        context: `${collab.detail}\n\n${responder.name}: ${note}`,
        why: `${requester.name} may be waiting on this.`,
        options: [
          { label: 'Do it next', description: `Create a high-priority task for ${responder.name}`, consequence: `It starts as soon as ${responder.name} finishes their current task.` },
          { label: 'Backlog it', description: 'Create a normal-priority task and keep current priorities' },
          { label: 'Decline', description: `Tell ${requester.name} it will not be done` },
        ],
        projectId: collab.projectId,
      });
    }
    return collab;
  }

  /** Assist XP is granted only once the helper's own task passed verification. */
  awardAssistsFor(taskId: string): void {
    for (const collab of this.core.collabs.filter((c) => c.status === 'incorporated' && c.responderTaskId === taskId)) {
      collab.status = 'resolved';
      this.core.put('collab', collab);
      const requester = this.core.employees.get(collab.fromEmployeeId);
      this.eng.tasks.awardXp(xpForAssist(collab.toEmployeeId, collab.id, `Delivered what ${requester?.name ?? 'a teammate'} asked for: ${truncate(collab.summary, 80)}`));
    }
  }

  // ────────────────────────── delivery queue ───────────────────────

  enqueue(d: Delivery, pump = true): void {
    let list = this.queue.get(d.employeeId);
    if (!list) this.queue.set(d.employeeId, (list = []));
    list.push(d);
    if (pump) this.schedulePump(d.employeeId, 0);
  }

  /** Queue a prompt for an employee's session (task, meeting, report request…). */
  deliver(employeeId: string, marker: Delivery['marker'], markerId: string, ref: Delivery['ref'], text: string): void {
    this.enqueue({ id: newId(), employeeId, marker, markerId, ref, text, createdAt: Date.now(), attempts: 0, sentAt: null, via: null, stopRequestId: null });
  }

  private dropQueued(match: (d: Delivery) => boolean): void {
    for (const [emp, list] of this.queue) {
      const kept = list.filter((d) => !match(d));
      if (kept.length !== list.length) this.queue.set(emp, kept);
    }
  }

  cancelFor(ref: Delivery['ref']): void {
    this.dropQueued((d) => d.ref.kind === ref.kind && d.ref.id === ref.id);
  }

  queued(employeeId: string): Delivery[] {
    return this.queue.get(employeeId) ?? [];
  }

  schedulePump(employeeId: string, delayMs = this.core.timings.deliverySettleMs): void {
    const due = Date.now() + delayMs;
    const existing = this.pumpTimers.get(employeeId);
    if (existing) {
      // Keep whichever fires first.
      if (existing.due <= due) return;
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.pumpTimers.delete(employeeId);
      void this.pump(employeeId).catch((e) => this.core.log('warn', `delivery pump for ${employeeId}: ${e.message}`));
    }, delayMs);
    timer.unref?.();
    this.pumpTimers.set(employeeId, { timer, due });
  }

  /** Why (if at all) Orchestrator must not type into this session right now. */
  private blockedReason(session: AgentSession | undefined): string | null {
    if (!session) return 'no running session';
    if (session.status !== 'running') return `session is ${session.status}`;
    if (!this.core.agents.isOnline(session.hostId)) return 'host offline';
    if (this.core.gateway.isHumanControlled(session.id)) return 'the owner is controlling the terminal';
    if (this.core.gateway.isPaused(session.id)) return 'paused by the owner';
    // With hooks we know when Claude is between turns; without them we cannot tell.
    if (session.capabilities.hooks && session.inTurn !== false) return session.inTurn === null ? 'waiting for the session to report in' : `mid-turn (${session.activity})`;
    return null;
  }

  /** What a queued delivery is, in words, for the record of why someone was woken. */
  private whatFor(d: Delivery): string {
    if (d.ref.kind === 'message') {
      const m = this.core.messages.get(d.ref.id);
      return m?.routineId ? 'a routine that was due' : `a message from ${m?.from.kind === 'owner' ? 'the boss' : (m?.from.name ?? 'a teammate')}`;
    }
    return { task: 'a task', question: 'the answer to their question', meeting: 'a meeting', report: 'a report the boss asked for', retro: 'a look back at their last task', round: 'a round' }[d.ref.kind];
  }

  /** Why the office could not start this employee's session for what is waiting for them; null when nothing went wrong. */
  wakeProblem(employeeId: string): string | null {
    return this.wakes.get(employeeId)?.problem ?? null;
  }

  /**
   * Something is waiting for an employee who has no session. Someone the office itself put to sleep is started
   * again for anything; someone who was never started, or whom the owner stopped, only for what asks for it.
   * One attempt at a time, and after a failed one not again for a while.
   */
  private wakeFor(employeeId: string, list: Delivery[]): void {
    // (Someone the office has already begun to wake for what is waiting stays wanted until it has been handed over.)
    if (!this.eng.sessions.asleep(employeeId) && !list.some((d) => d.wake) && !this.wakes.has(employeeId)) return;
    const now = Date.now();
    const last = this.wakes.get(employeeId);
    if (last?.running || (last?.problem && now - last.at < this.core.timings.wakeRetryMs)) return;
    const employee = this.core.employees.get(employeeId);
    const no = this.eng.sessions.cannotStart(employee);
    if (no) {
      // Nothing to try (their machine is away): said once, tried again when the machine is back or something new arrives.
      this.wakes.set(employeeId, { at: now, problem: no, running: false });
      return;
    }
    this.wakes.set(employeeId, { at: now, problem: null, running: true });
    void this.eng.sessions
      .wake(employeeId, this.whatFor(list.find((d) => d.wake) ?? list[0]!))
      .then(() => this.wakes.set(employeeId, { at: Date.now(), problem: null, running: false }))
      .catch((e: Error) => {
        const again = last?.problem === e.message;
        this.wakes.set(employeeId, { at: Date.now(), problem: e.message, running: false });
        if (!again) this.core.event({ type: 'session.lost', source: 'server', summary: `${employee?.name ?? 'An employee'} could not be woken for ${this.whatFor(list[0]!)}: ${truncate(e.message, 160)}`, employeeId, data: { wake: true, reason: e.message } });
      });
  }

  /** A machine is back: whoever on it has something waiting gets another look. */
  hostBack(hostId: string): void {
    for (const [employeeId, list] of this.queue) {
      if (!list.length || this.core.employees.get(employeeId)?.hostId !== hostId) continue;
      this.wakes.delete(employeeId);
      this.schedulePump(employeeId, 500);
    }
  }

  /**
   * Is anything on its way to this employee: queued, or handed over and still waiting to be acknowledged?
   * `exceptRoutines`: runs of routines do not count (two routines of one employee that come due together are both
   * handed over, one after the other — neither holds the other back for good).
   */
  pending(employeeId: string, exceptRoutines = false): boolean {
    const counts = (d: Delivery) => !exceptRoutines || d.ref.kind !== 'message' || !this.core.messages.get(d.ref.id)?.routineId;
    if (this.queue.get(employeeId)?.some(counts)) return true;
    const flying = this.inflight.get(employeeId);
    return !!flying && counts(flying) && Date.now() - (flying.sentAt ?? 0) < this.core.timings.deliveryConfirmMs;
  }

  async pump(employeeId: string): Promise<void> {
    const list = this.queue.get(employeeId);
    if (!list?.length) return;
    const session = this.core.runningSessionOf(employeeId);
    if (!session) return this.wakeFor(employeeId, list);
    const flying = this.inflight.get(employeeId);
    if (flying) {
      // One prompt at a time: wait for the hook that confirms it (or give up waiting).
      if (Date.now() - (flying.sentAt ?? 0) < this.core.timings.deliveryConfirmMs) return this.schedulePump(employeeId, 1000);
      this.inflight.delete(employeeId);
      this.markUnconfirmed(flying);
    }
    if (this.blockedReason(session)) return;
    const d = list.shift()!;
    d.attempts++;
    const hooks = session!.capabilities.hooks;
    // An SDK-managed worker takes the prompt as structured input; nothing is typed into its terminal.
    d.via = session!.mode === 'managed_sdk' ? 'sdk' : 'terminal_paste';
    d.sentAt = Date.now();
    // Tracked before it is sent: the acknowledging hook can arrive in the same network read as the
    // host's reply to the send, i.e. before the code after the await below has run.
    if (hooks) this.inflight.set(employeeId, d);
    try {
      const sent = await this.core.agents.rpc<{ via?: string }>(session!.hostId, { method: 'session.paste', params: { sessionId: session!.id, text: d.text, submit: true } }, 15000);
      d.sentAt = Date.now();
      this.wakes.delete(employeeId);
      if (sent?.via === 'sdk' || sent?.via === 'terminal') d.via = sent.via === 'sdk' ? 'sdk' : 'terminal_paste';
      if (hooks) {
        // Still waiting for the acknowledgement? Then it is "sent". (If the hook already came, it is confirmed.)
        if (this.inflight.get(employeeId) === d) {
          this.markSent(d, session!);
          this.schedulePump(employeeId, this.core.timings.deliveryConfirmMs + 200);
        } else this.schedulePump(employeeId, 200);
      } else {
        this.markSent(d, session!);
        // No hooks: nothing will ever confirm this, and we cannot see when the agent is idle again.
        this.markUnconfirmed(d);
        if (list.length) this.schedulePump(employeeId, 4000);
      }
    } catch (e) {
      if (this.inflight.get(employeeId) === d) this.inflight.delete(employeeId);
      if (d.attempts < 3) {
        list.unshift(d);
        this.schedulePump(employeeId, 2000);
      } else this.markFailed(d, (e as Error).message);
    }
  }

  /**
   * A Stop hook is waiting on a host. If prompts are queued for this employee,
   * hand them over as the hook's "keep going" reason — a structured path that
   * needs no typing into the terminal.
   */
  takeForStopHook(employeeId: string, requestId: string): string | null {
    const list = this.queue.get(employeeId);
    const session = this.core.runningSessionOf(employeeId);
    if (!list?.length || !session) return null;
    if (this.core.gateway.isHumanControlled(session.id) || this.core.gateway.isPaused(session.id)) return null;
    const batch = list.splice(0, list.length);
    for (const d of batch) {
      d.attempts++;
      d.sentAt = Date.now();
      d.via = 'stop_hook';
      d.stopRequestId = requestId;
      this.markSent(d, session);
    }
    this.stopBatches.set(requestId, batch);
    return batch.map((d) => d.text).join('\n\n---\n\n');
  }

  private requeue(d: Delivery): void {
    d.via = null;
    d.sentAt = null;
    d.stopRequestId = null;
    let list = this.queue.get(d.employeeId);
    if (!list) this.queue.set(d.employeeId, (list = []));
    list.unshift(d);
    this.applyState(d, 'queued', null, 'Delivery was not consumed; queued again');
    this.schedulePump(d.employeeId);
  }

  private applyState(d: Delivery, status: 'queued' | 'sent' | 'confirmed' | 'failed', via: Delivery['via'], detail: string): void {
    const state = { status, via, ts: nowIso(), detail };
    if (d.ref.kind === 'message') {
      const m = this.core.messages.get(d.ref.id);
      if (m) {
        m.delivery = state;
        this.core.put('message', m);
        if (status === 'confirmed' || status === 'sent') {
          const to = this.core.employees.get(m.toEmployeeId);
          if (status === 'confirmed') {
            this.core.event({
              type: 'agent.message_delivered',
              source: 'server',
              summary: `Message delivered to ${to?.name ?? 'employee'}`,
              employeeId: m.toEmployeeId,
              correlationId: m.threadId ?? m.id,
              data: { messageId: m.id, via, quiet: true },
            });
          }
        }
      }
    } else if (d.ref.kind === 'task') {
      this.eng.tasks.onDeliveryState(d.ref.id, state);
    } else if (d.ref.kind === 'question') {
      const q = this.core.questions.get(d.ref.id);
      if (q) {
        if (status === 'sent' && q.status === 'answered') this.setStatus(q, 'delivered', via === 'stop_hook' ? 'Handed to the agent through the Stop hook' : via === 'sdk' ? 'Handed to the agent through the Agent SDK' : 'Typed into the terminal');
        else if (status === 'confirmed' && (q.status === 'answered' || q.status === 'delivered')) this.setStatus(q, 'confirmed', detail);
        else if (status === 'failed') this.setStatus(q, 'failed', detail);
      }
    } else if (d.ref.kind === 'meeting') {
      this.eng.meetings.onDeliveryState(d.ref.id, d.employeeId, state);
    } else if (d.ref.kind === 'round') {
      this.eng.foreman.onDeliveryState(d.ref.id, state);
    }
  }

  private markSent(d: Delivery, session: AgentSession): void {
    const detail = d.via === 'stop_hook' ? 'Handed to Claude Code as Stop-hook feedback' : d.via === 'sdk' ? 'Handed to the worker as structured input through the Agent SDK; waiting for it to acknowledge' : session.capabilities.hooks ? 'Typed into the terminal; waiting for Claude Code to acknowledge' : 'Typed into the terminal (this session has no hooks, so receipt cannot be confirmed)';
    this.applyState(d, 'sent', d.via, detail);
  }

  private markConfirmed(d: Delivery, detail: string): void {
    this.applyState(d, 'confirmed', d.via, detail);
  }

  private markUnconfirmed(d: Delivery): void {
    // Stays "sent": we will not claim a confirmation we did not get.
    this.core.log('info', `delivery ${d.marker}:${d.markerId} to ${d.employeeId} was sent but not confirmed by a hook`);
  }

  private markFailed(d: Delivery, reason: string): void {
    this.applyState(d, 'failed', d.via, reason);
    const emp = this.core.employees.get(d.employeeId);
    this.notify({ kind: 'info', severity: 'warning', title: `Could not deliver to ${emp?.name ?? 'employee'}`, body: reason, employeeId: d.employeeId });
  }

  /** A UserPromptSubmit hook carried one of our correlation markers. */
  confirmMarker(employeeId: string, kind: string, id: string): void {
    const flying = this.inflight.get(employeeId);
    if (flying && flying.marker === kind && flying.markerId === id) {
      this.inflight.delete(employeeId);
      this.markConfirmed(flying, 'Claude Code acknowledged the prompt (UserPromptSubmit)');
      return;
    }
    // Confirmation for something we no longer track in memory (e.g. after a restart).
    const ghost: Delivery = { id: newId(), employeeId, marker: kind as Delivery['marker'], markerId: id, ref: { kind: 'message', id }, text: '', createdAt: Date.now(), attempts: 1, sentAt: Date.now(), via: this.core.runningSessionOf(employeeId)?.mode === 'managed_sdk' ? 'sdk' : 'terminal_paste', stopRequestId: null };
    if (kind === 'TASK') ghost.ref = { kind: 'task', id };
    else if (kind === 'ANSWER') ghost.ref = { kind: 'question', id };
    else if (kind === 'MSG') ghost.ref = { kind: 'message', id };
    else return;
    this.markConfirmed(ghost, 'Claude Code acknowledged the prompt (UserPromptSubmit)');
  }

  /** Drop everything queued for a session that no longer exists. */
  employeeSessionGone(employeeId: string): void {
    this.inflight.delete(employeeId);
  }

  marker(kind: Delivery['marker'], id: string): string {
    return correlationMarker(kind, id);
  }
}
