import type { AgentSession, CollabRequest, Employee, Message, MessageKind, Notification, NotificationKind, Question, QuestionOption } from '@orchestrator/contracts';
import { correlationMarker, matchRole, newId, nowIso, optionsIn, truncate } from '@orchestrator/contracts';
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
  return optionKeys(lines, (label) => /^Yes\b/.test(label));
}

/**
 * A screen's lines as plain text, for the patterns below: colour codes out, and no more of a line than a wide
 * terminal shows. (A machine's agent sends what it captured; a member's own computer could send lines of any length,
 * and three of these patterns take time with the square or the cube of a line of spaces.)
 */
export function plainScreen(lines: string[]): string[] {
  return (Array.isArray(lines) ? lines : []).slice(-500).map((l) => String(l ?? '').slice(0, 8000).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(0, 600));
}

/**
 * The keys that move, in a numbered menu on screen ("❯ 1. Stop and wait for limit to reset", "  2. …"), from the
 * marked option to the one `wanted` picks, and confirm it. Null when the menu cannot be read — no key is pressed blind.
 */
export function menuKeys(lines: string[], wanted: (label: string) => boolean): string[] | null {
  const options: Array<{ selected: boolean; label: string }> = [];
  for (const line of plainScreen(lines)) {
    const m = /^[\s│┃|]*(❯|>|›)?\s*\d+\.\s+(.+?)[\s│┃|]*$/.exec(line);
    if (m) options.push({ selected: !!m[1], label: m[2]!.trim() });
  }
  const from = options.findIndex((o) => o.selected);
  const to = options.findIndex((o) => wanted(o.label));
  if (options.length < 2 || from < 0 || to < 0) return null;
  const keys: string[] = [];
  for (let i = 0; i < Math.abs(to - from); i++) keys.push(to > from ? 'Down' : 'Up');
  keys.push('Enter');
  return keys;
}

/** The keys that move from the highlighted option of a Yes/No list on screen to the one `wanted` picks, and confirm it. */
function optionKeys(lines: string[], wanted: (label: string) => boolean): string[] | null {
  const plain = plainScreen(lines);
  const options: Array<{ selected: boolean; label: string }> = [];
  for (const line of plain) {
    // (A dialog may be drawn in a box: its border stands before and after the option.)
    const m = /^[\s│┃|]*(❯|>|›)?\s*(?:\d+\.\s*)?((?:Yes|No)\b.*?)[\s│┃|]*$/.exec(line);
    if (!m) continue;
    options.push({ selected: !!m[1], label: m[2]!.trim() });
  }
  const from = options.findIndex((o) => o.selected);
  const to = options.findIndex((o) => wanted(o.label));
  if (options.length < 2 || from < 0 || to < 0) return null;
  const keys: string[] = [];
  for (let i = 0; i < Math.abs(to - from); i++) keys.push(to > from ? 'Down' : 'Up');
  keys.push('Enter');
  return keys;
}

/**
 * Claude Code's input box, as it stands in a terminal, and what is typed in it — or null when the screen shows
 * something else: a dialog with numbered answers (where Enter would choose one), a program that is not at a prompt.
 * The box is what lies between the last two horizontal rules, starting with the prompt sign; a terminal without
 * rules that ends in a line with the prompt sign counts too.
 *
 * Read when a prompt was typed into a session and never acknowledged: a session that was only just started takes
 * the pasted text when it is ready and loses the Enter that came with it — the text then stands in the box, unsent,
 * and the employee sits in front of it (seen on the live office, 2026-11-12: a review that waited 40 minutes).
 */
export function inputBox(lines: string[]): { text: string } | null {
  const plain = plainScreen(lines).map((l) => l.trimEnd());
  while (plain.length && !plain[plain.length - 1]!.trim()) plain.pop();
  if (!plain.length) return null;
  const tail = plain.slice(-40);
  // A list of numbered answers is a dialog: Enter there is an answer, not a submission.
  if (tail.filter((l) => /^\s*(?:❯|>|›)?\s*\d+\.\s+\S/.test(l)).length >= 2 && tail.some((l) => /^\s*(?:❯|>|›)\s*\d+\.\s/.test(l))) return null;
  const rule = (l: string) => /^\s*[─━═╌-]{20,}\s*$/.test(l);
  const sign = /^\s*(?:❯|>)(?:\s|$)/;
  let bottom = -1;
  for (let i = tail.length - 1; i >= 0; i--) if (rule(tail[i]!)) { bottom = i; break; } // prettier-ignore
  if (bottom > 0) {
    let top = -1;
    for (let i = bottom - 1; i >= 0; i--) if (rule(tail[i]!)) { top = i; break; } // prettier-ignore
    const inside = tail.slice(top + 1, bottom);
    if (top >= 0 && inside.length && sign.test(inside[0]!)) return { text: inside.join('\n').replace(sign, '').trim() };
  }
  const last = tail[tail.length - 1]!;
  return sign.test(last) ? { text: last.replace(sign, '').trim() } : null;
}

/** Does the box hold this prompt — its end, as the box shows the end of a long text — or a paste folded into a tag? */
export function boxHolds(box: { text: string }, prompt: string): boolean {
  if (/\[pasted\b/i.test(box.text)) return true;
  const bare = (t: string) => t.replace(/\s+/g, '');
  const end = bare(prompt).slice(-48);
  return end.length >= 12 && bare(box.text).includes(end);
}

/**
 * Claude Code's own permission dialog, as it stands in a terminal: what it asks about, and the keys for each answer.
 * Null when the screen shows none. It is there when the office could not hold the request — the wait for an answer
 * ran out, or the office was restarted meanwhile — and then the employee waits at it until somebody answers.
 *
 * "Allow" is the plain *Yes* — never "Yes, and don't ask again", which would widen what the session may do.
 */
export function permissionPrompt(lines: string[]): { what: string; allow: string[] | null; deny: string[] | null } | null {
  const plain = plainScreen(lines).map((l) => l.trimEnd());
  // The question is the last "Do you want to …?" on screen, with its numbered options right under it.
  let at = -1;
  for (let i = plain.length - 1; i >= 0; i--) {
    if (/^\s*│?\s*Do you want to\b.*\?\s*│?$/.test(plain[i]!)) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const below = plain.slice(at + 1, at + 8);
  const isOption = (l: string) => /^\s*│?\s*(❯|>|›)?\s*\d+\.\s*(Yes|No)\b/.test(l);
  if (!below.some((l) => /^\s*│?\s*(❯|>|›)\s*\d+\.\s*(Yes|No)\b/.test(l))) return null;
  // A dialog that is being shown is the bottom of the screen: after its options come only its own last lines
  // (the key hints, a border). Anything more means the session is past it and this is old text further up.
  const lastOption = at + 1 + below.map(isOption).lastIndexOf(true);
  if (plain.slice(lastOption + 1).filter((l) => l.trim()).length > 3) return null;
  const options = below.map((l) => l.replace(/^\s*│\s?/, '').replace(/\s*│$/, ''));
  const allow = optionKeys(options, (label) => /^Yes$/.test(label)) ?? optionKeys(options, (label) => /^Yes\b/.test(label) && !/don.t ask|always|all /i.test(label));
  const deny = optionKeys(options, (label) => /^No\b/.test(label));
  // What it is about: the boxed lines of the dialog above the question (the command or file, and why it is asked),
  // up to the rule that opens the dialog.
  let top = at;
  while (top > 0 && at - top < 40 && !/^\s*[─━]{20,}/.test(plain[top - 1]!)) top--;
  const above = plain.slice(top, at);
  const boxed = above.filter((l) => /^\s*│/.test(l)).map((l) => l.replace(/^\s*│\s?/, '').replace(/\s*│$/, '').trim());
  const what = (boxed.length ? boxed : above.filter((l) => l.trim()).slice(-3).map((l) => l.trim())).filter((l) => l && !/^\[settings\]$/.test(l)).join('\n');
  return { what: what.slice(0, 1500), allow, deny };
}

/** How a message is marked that reached its reader as the result of the tool call that was waiting for it. */
const RETURNED = 'Returned as the result of the tool call that was waiting for it';

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
  /** How many times it was sent again after Claude Code did not acknowledge it (see `recover`). */
  recovered?: number;
}

interface HookPending {
  hostId: string;
  requestId: string;
  /** `pretool`: a high-risk call held before it runs (bypass mode), answered in the shape of a PreToolUse hook. */
  kind: 'permission' | 'ask_user' | 'pretool';
  toolInput: any;
  /** The hook event's own id: the same when the machine sends the held request again. */
  eventId?: string;
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
  /** Deliveries Claude Code has acknowledged. One of these is done with, whatever is heard about it afterwards. */
  private taken = new WeakSet<Delivery>();
  private pumpTimers = new Map<string, { timer: NodeJS.Timeout; due: number }>();
  private hookPending = new Map<string, HookPending>();
  /** Questions whose hook a machine may still be holding although the link to it is gone (see `rejoinHook`). */
  private awaitingRejoin = new Set<string>();
  /** Of those, the ones answered meanwhile: the answer goes out when the machine is back. */
  private unsentAnswers = new Set<string>();
  private rejoinTimers = new Map<string, NodeJS.Timeout>();
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
    // A question held on a hook: the machine keeps holding it through a restart of the office (for a minute and a
    // half) and sends it again when it is back — see `rejoinHook`. Until then it stays as it is. One that does not
    // come back is given up (`giveUpHeld`): Claude Code then shows its own prompt in the terminal, which is noticed
    // on the session's screen and asked anew (SessionRegistry.onScreen).
    for (const q of this.core.questions.filter((x) => x.status === 'open' && (x.channel === 'permission_hook' || x.channel === 'ask_user_question_hook'))) {
      if (q.hookEventId) this.awaitingRejoin.add(q.id);
      else this.supersede(q.id, 'Orchestrator restarted while this request was pending; Claude Code falls back to its own prompt in the terminal.');
    }
    // Answered, and the office was restarted before it knew the answer had arrived: if the machine still holds the
    // hook it sends it again and gets the answer (again); if not, the question is closed when the wait for it ends.
    for (const q of this.core.questions.filter((x) => x.status === 'answered' && (x.channel === 'permission_hook' || x.channel === 'ask_user_question_hook'))) {
      if (!q.hookEventId) {
        this.setStatus(q, 'failed', 'The office was restarted before this answer was known to have arrived.');
        continue;
      }
      this.awaitingRejoin.add(q.id);
      this.unsentAnswers.add(q.id);
    }
    if (this.awaitingRejoin.size) this.rejoinTimer('*', this.core.timings.hookRejoinMs ?? 120_000);
    // Questions that were asked with their choices written into the text, before the office read them out of it.
    for (const q of this.core.questions.filter((x) => x.status === 'open' && x.channel === 'mcp_tool' && x.kind !== 'permission' && !x.options.length && !x.parts.length)) {
      const found = optionsIn(q.text);
      if (!found.length) continue;
      q.options = found;
      this.core.put('question', q);
    }
    // (The same employee, the same task, the same words.)
    // The same question asked twice by the same employee (before the office knew to recognise it): one stays.
    const kept = new Set<string>();
    for (const q of this.core.questions.filter((x) => x.status === 'open' && x.channel === 'mcp_tool' && !!x.employeeId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const key = `${q.employeeId}|${q.taskId ?? ''}|${q.text.trim().replace(/\s+/g, ' ')}`;
      if (kept.has(key)) this.supersede(q.id, 'The same question was asked again; the later one is the one that waits for the answer.');
      else kept.add(key);
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
    /** Asked in a task's conversation: the comment is written by whoever asks, not mirrored from here. */
    onTask?: boolean;
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
      // However it was asked (a tool, a hook, the office itself), a question has a length: it is read by people, and
      // by the office's own comparisons of questions with one another.
      text: truncate(q.text, 4000),
      context: truncate(q.context ?? '', 16_000),
      why: truncate(q.why ?? '', 2000),
      // Choices the employee wrote into the question instead of giving them ("A) … B) …") are choices all the same:
      // read out of the text, they are there to click at the desk, in the Inbox and on the task.
      options: (q.options?.length ? q.options : q.channel === 'mcp_tool' && q.kind !== 'permission' ? optionsIn(q.text) : []).slice(0, 24),
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
    // A question about a task is part of that task's conversation.
    if (!q.onTask) this.eng.talk.questionAsked(question);
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

  /**
   * A question this employee has already put to the boss in the same words and that is still waiting (or answered
   * and not handed over yet). Asking it again is waiting for the same answer.
   */
  sameQuestion(employeeId: string, text: string, taskId: string | null): Question | undefined {
    const norm = (t: string) => t.trim().replace(/\s+/g, ' ');
    const wanted = norm(text);
    // (On the same task: the same sentence asked about another task is another question.)
    return this.core.questions
      .filter((q) => q.employeeId === employeeId && q.channel === 'mcp_tool' && (q.status === 'open' || q.status === 'answered') && (q.taskId ?? null) === taskId && norm(q.text) === wanted)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  /** A blocking hook is being held open on a host until this question is answered. */
  holdHook(question: Question, pending: HookPending): void {
    this.hookPending.set(question.id, pending);
    this.requestToQuestion.set(pending.requestId, question.id);
    if (pending.eventId && question.hookEventId !== pending.eventId) {
      question.hookEventId = pending.eventId;
      this.core.put('question', question);
    }
  }

  /**
   * A machine sends a held request again — it kept holding it while the office was restarted or the connection was
   * lost. If the question it belongs to is still waiting here, it is taken up again as it stands (and an answer given
   * meanwhile is delivered now). False: this is not such a request.
   */
  rejoinHook(hostId: string, requestId: string, raw: { id: string; payload?: { hook_event_name?: string; tool_input?: unknown } }): boolean {
    const q = this.core.questions.find((x) => !!x.hookEventId && x.hookEventId === raw.id && (x.status === 'open' || x.status === 'answered') && (x.channel === 'permission_hook' || x.channel === 'ask_user_question_hook'));
    if (!q || this.core.sessions.get(q.sessionId)?.hostId !== hostId) return false;
    // Held under another name before (the machine's agent was restarted and the hook came to it anew): that one is over.
    const before = this.hookPending.get(q.id);
    if (before) this.requestToQuestion.delete(before.requestId);
    this.awaitingRejoin.delete(q.id);
    const kind: HookPending['kind'] = q.channel === 'ask_user_question_hook' ? 'ask_user' : raw.payload?.hook_event_name === 'PreToolUse' ? 'pretool' : 'permission';
    this.holdHook(q, { hostId, requestId, kind, toolInput: raw.payload?.tool_input, eventId: raw.id });
    // What the session is doing is not kept across a restart of the office: it is waiting for this.
    const session = this.core.sessions.get(q.sessionId);
    if (session && q.status === 'open' && q.kind === 'permission' && session.activity !== 'paused' && session.activity !== 'needs_approval') this.eng.sessions.setActivity(session, 'needs_approval', truncate(q.text.replace(/^.*? wants to run: /, ''), 200));
    if (q.status === 'answered') {
      this.unsentAnswers.delete(q.id);
      this.answerHook(q);
    }
    return true;
  }

  /** A machine's connection is gone. What it was holding for us it may still hold: those questions wait for it. */
  hostGone(hostId: string): void {
    let any = false;
    for (const [qid, pending] of [...this.hookPending]) {
      if (pending.hostId !== hostId) continue;
      this.hookPending.delete(qid);
      this.requestToQuestion.delete(pending.requestId);
      const q = this.core.questions.get(qid);
      if (!q || (q.status !== 'open' && q.status !== 'answered')) continue;
      this.awaitingRejoin.add(qid);
      any = true;
    }
    if (any) this.rejoinTimer(hostId, this.core.timings.hookRejoinMs ?? 120_000);
  }

  /** A machine has reported in again. What it still holds follows at once; what does not come is no longer held. */
  private heldBack(hostId: string): void {
    if (![...this.awaitingRejoin].some((qid) => this.core.sessions.get(this.core.questions.get(qid)?.sessionId)?.hostId === hostId)) return;
    this.rejoinTimer(hostId, this.core.timings.hookRejoinGraceMs ?? 10_000);
  }

  private rejoinTimer(key: string, ms: number): void {
    const old = this.rejoinTimers.get(key);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.rejoinTimers.delete(key);
      this.giveUpHeld(key === '*' ? null : key);
    }, ms);
    t.unref?.();
    this.rejoinTimers.set(key, t);
  }

  /** Nothing came back for these: Claude Code is no longer waiting on the hook, its own prompt stands in the terminal. */
  private giveUpHeld(hostId: string | null): void {
    for (const qid of [...this.awaitingRejoin]) {
      const q = this.core.questions.get(qid);
      if (hostId && q && this.core.sessions.get(q.sessionId)?.hostId !== hostId) continue;
      this.awaitingRejoin.delete(qid);
      if (!q || this.hookPending.has(qid)) continue;
      if (q.status === 'open') this.fellToTerminal(q, 'The office was restarted, or the connection to the machine was lost, while this was pending; Claude Code falls back to its own prompt in the terminal.');
      else if (q.status === 'answered' && this.unsentAnswers.delete(qid)) {
        this.setStatus(q, 'failed', 'Claude Code was no longer waiting when its machine came back; answer the prompt in the terminal instead.');
        if (q.kind === 'permission' && q.sessionId) this.eng.sessions.promptOnScreen(q.sessionId, true);
      } else if (q.status === 'answered') {
        // Sent to the machine just before the connection went; whether it arrived was never heard. If it did, the
        // tool's own report confirms it later; if not, Claude Code asks in the terminal, and that is found there.
        this.setStatus(q, 'delivered', 'Sent to the machine before the connection to it was lost; its arrival was not confirmed.');
        if (q.kind === 'permission' && q.sessionId) this.eng.sessions.promptOnScreen(q.sessionId, true);
      }
    }
  }

  /**
   * A held question was let go without an answer: Claude Code now asks in the terminal itself. A permission prompt
   * the office can see there is asked again from here; otherwise the owner is told where the employee waits.
   */
  private fellToTerminal(q: Question, detail: string): void {
    this.supersede(q.id, detail);
    const emp = this.core.employees.get(q.employeeId);
    if (q.kind === 'permission' && q.sessionId && this.eng.sessions.promptOnScreen(q.sessionId, true)) return;
    if (q.kind !== 'permission' && this.core.sessions.get(q.sessionId)?.status !== 'running') return;
    this.notify({
      kind: q.kind === 'permission' ? 'permission' : 'question',
      severity: 'warning',
      title: `${emp?.name ?? 'Employee'} is waiting at a ${q.kind === 'permission' ? 'terminal prompt' : 'question in the terminal'}`,
      body:
        q.kind === 'permission'
          ? 'The request was not answered in time, so Claude Code is showing its own permission prompt. Open the workstation to answer it.'
          : `${truncate(q.text, 300)}\n\nIt was not answered from the office in time, so Claude Code is asking in the terminal itself, and ${emp?.name ?? 'the employee'} waits there. Open the workstation to answer it.`,
      employeeId: q.employeeId,
      sessionId: q.sessionId,
    });
  }

  /** Write the answer of a question held on a hook to that hook. */
  private answerHook(q: Question): void {
    const pending = this.hookPending.get(q.id);
    if (!pending) {
      // Its machine may come back still holding it (the office was restarted, or the connection was lost): the
      // answer is kept and delivered then.
      if (this.awaitingRejoin.has(q.id)) {
        this.unsentAnswers.add(q.id);
        q.deliveryDetail = 'Kept until the employee\'s machine is connected again';
        this.core.put('question', q);
        return;
      }
      return this.setStatus(q, 'failed', q.channel === 'permission_hook' ? 'The permission hook is no longer waiting; answer the prompt in the terminal instead.' : 'Claude Code is no longer waiting on this question; answer it in the terminal instead.');
    }
    if (q.channel === 'permission_hook') {
      const decision = q.decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: q.answer || 'Denied by the boss in Orchestrator.' };
      const output =
        pending.kind === 'pretool'
          ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: q.decision === 'allow' ? 'allow' : 'deny', permissionDecisionReason: q.decision === 'allow' ? 'Allowed by the boss in Orchestrator.' : q.answer || 'Denied by the boss in Orchestrator.' } }
          : { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
      if (!this.core.agents.respondHook(pending.hostId, pending.requestId, output)) this.setStatus(q, 'failed', 'The host is offline; the decision could not be delivered.');
      return;
    }
    const by = q.answeredBy?.kind === 'foreman' ? q.answeredBy : null;
    const answers = q.answers ?? (q.parts[0] ? { [q.parts[0].question]: q.answer ?? '' } : {});
    const ok = this.core.agents.respondHook(pending.hostId, pending.requestId, {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: by ? `Answered by ${by.name} (the foreman) on the boss's behalf` : 'Answered by the boss in Orchestrator', updatedInput: { ...(pending.toolInput ?? {}), answers } },
    });
    if (!ok) this.setStatus(q, 'failed', 'The host is offline; the answer could not be delivered.');
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
    this.awaitingRejoin.delete(questionId);
    this.unsentAnswers.delete(questionId);
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
  waitForAnswer(questionId: string, timeoutMs: number, signal?: AbortSignal): Promise<Question | null> {
    const q = this.core.questions.get(questionId);
    if (!q) return Promise.resolve(null);
    if (q.status !== 'open') return Promise.resolve(q);
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let set = this.waiters.get(questionId);
      if (!set) this.waiters.set(questionId, (set = new Set()));
      const gone = () => {
        clearTimeout(timer);
        set!.delete(fn);
        if (!set!.size && this.waiters.get(questionId) === set) this.waiters.delete(questionId);
        resolve(null);
      };
      const fn = (answered: Question) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', gone);
        resolve(answered);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', gone);
        set!.delete(fn);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      // The call that was waiting is gone (the caller hung up): nobody listens there any more, and an answer must
      // not be counted as returned by it.
      signal?.addEventListener('abort', gone, { once: true });
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
      // What is allowed is everything the tool was given. A request the office cannot show in full is not allowed
      // from here on the strength of its beginning.
      if (input.decision === 'allow' && q.tool?.notShown) throw new EngineError(`This request is too long to show in full (${q.tool.notShown} characters are not shown), so it cannot be allowed from the office. Deny it, or decide it at the employee's terminal.`);
    } else if (q.parts.length) {
      for (const part of q.parts) if (!input.answers?.[part.question]) throw new EngineError(`missing answer for: ${part.question}`);
    } else if (!input.answer?.trim()) throw new EngineError('an answer is required');

    // An answer that carries a credential ("the password is …"): the credential goes to the vault, the answer names it.
    if (input.answer) input = { ...input, answer: this.eng.vault.capture(input.answer, by ? { kind: 'employee', id: by.id, name: by.name } : { kind: 'owner', id: null, name: actor === 'owner' ? 'The boss' : actor.replace(/^[a-z]+:/, '') }, [employee?.name ?? '']).text };
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
      case 'permission_hook':
      case 'ask_user_question_hook':
        this.answerHook(q);
        break;
      case 'mcp_tool': {
        // Written on the task it was asked on; a task that was parked on it goes back to its employee with it.
        const onTask = this.eng.talk.hasWaiterFor(q);
        const returned = this.eng.talk.questionAnswered(q, actor);
        if (this.hasWaiter(q.id)) this.wake(q);
        else if (returned) this.setStatus(q, 'delivered', 'Given back with the task that waited for it');
        else if (onTask) this.setStatus(q, 'delivered', 'Returned as the result of the comment_on_task call');
        else if (q.employeeId) this.enqueueAnswer(q, true);
        else this.setStatus(q, 'failed', 'No session to deliver the answer to.');
        // Whoever asked was given nothing new while the question was open: now they can be.
        this.eng.tasks.schedule();
        break;
      }
      case 'terminal': {
        // e.g. the workspace trust prompt: the answer is a keypress in the real terminal.
        const session = this.core.sessions.get(q.sessionId);
        if (!session || !this.core.agents.isOnline(session.hostId)) {
          this.setStatus(q, 'failed', 'The session is not reachable.');
          break;
        }
        if (q.kind === 'permission') {
          // Answered with keys, worked out from what the prompt shows right now — and only if it still shows.
          const prompt = permissionPrompt(this.core.gateway.screens.get(session.id)?.lines ?? []);
          const keys = prompt ? (q.decision === 'allow' ? prompt.allow : prompt.deny) : null;
          if (!keys) {
            this.setStatus(q, 'failed', prompt ? 'Could not find that answer among the options on screen; open the workstation and answer it in the terminal.' : 'The prompt is no longer on the screen: it was answered in the terminal, or the session moved on.');
            break;
          }
          try {
            await this.core.agents.rpc(session.hostId, { method: 'session.keys', params: { sessionId: session.id, keys } });
            this.setStatus(q, 'delivered', `Chose "${q.decision === 'allow' ? 'Yes' : 'No'}" on the prompt in the terminal (${keys.join(' ')})`);
          } catch (e) {
            this.setStatus(q, 'failed', (e as Error).message);
          }
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
            // Claude Code's bypass warning is accepted per account: sessions of the same account on the same machine
            // that stand at it too (several were started together) are answered with it, not asked one by one.
            if (q.tool?.name === 'bypass_warning') {
              for (const other of this.core.questions.filter((x) => x.id !== q.id && x.status === 'open' && x.channel === 'terminal' && x.tool?.name === 'bypass_warning' && JSON.stringify(x.tool.input) === JSON.stringify(q.tool!.input))) {
                const os = this.core.sessions.get(other.sessionId);
                const ok = os ? trustPromptKeys(this.core.gateway.screens.get(os.id)?.lines ?? []) : null;
                if (!os || !ok) continue;
                other.answer = q.answer;
                other.answeredAt = nowIso();
                this.core.put('question', other);
                await this.core.agents.rpc(os.hostId, { method: 'session.keys', params: { sessionId: os.id, keys: ok } }).then(
                  () => this.setStatus(other, 'delivered', 'Accepted with your answer for the same Claude account'),
                  () => undefined,
                );
              }
            }
          } catch (e) {
            this.setStatus(q, 'failed', (e as Error).message);
          }
        } else {
          this.setStatus(q, 'superseded', 'Left for the owner to handle in the terminal.');
        }
        break;
      }
      case 'auto_denied': {
        // Claude Code's own check refused it. The owner's word is given to the session the two ways Claude Code
        // takes one: the machine lets exactly that call through once, and the employee is told — as a message from
        // the owner, in the conversation — that it may run it again.
        const session = this.core.sessions.get(q.sessionId);
        const employee = this.core.employees.get(q.employeeId);
        if (!session || session.status !== 'running' || !employee) {
          this.setStatus(q, 'failed', 'The session is no longer running.');
          break;
        }
        const what = typeof (q.tool?.input as any)?.command === 'string' ? String((q.tool!.input as any).command) : `${q.tool?.name ?? 'the tool'} ${JSON.stringify(q.tool?.input ?? {})}`;
        if (q.decision === 'allow') {
          const granted = await this.eng.sessions.grantOnce(session, q.tool?.name ?? '', q.tool?.input ?? {}).catch(() => false);
          this.sendMessage({ from: { kind: 'owner', id: null, name: 'the boss' }, toEmployeeId: employee.id, kind: 'system', taskId: q.taskId, body: `I, the owner of this office, allow this once — exactly as you tried it:\n${truncate(what, 1500)}\n\nRun exactly the same call again now. If it is refused again, do not look for a way around it: say so with report_blocker.` });
          this.setStatus(q, 'delivered', granted ? 'Allowed once: the machine lets exactly that call through, and the employee was told to run it again' : 'The employee was told that you allow it (this machine could not be told to let the call through)');
        } else {
          this.sendMessage({ from: { kind: 'owner', id: null, name: 'the boss' }, toEmployeeId: employee.id, kind: 'system', taskId: q.taskId, body: `The action that was refused stays refused (${truncate(what, 200)}).${q.answer ? ` ${q.answer}` : ''} Do it another way, or report_blocker if the task cannot be done without it.` });
          this.setStatus(q, 'confirmed', 'Left refused; the employee was told');
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
    const wasHeld = this.hookPending.get(qid)?.kind === 'pretool';
    this.hookPending.delete(qid);
    const q = this.core.questions.get(qid);
    if (!q) return;
    if (outcome === 'delivered' && q.status === 'answered') {
      this.setStatus(q, 'delivered', q.channel === 'permission_hook' ? 'Decision written to the PermissionRequest hook' : 'Answer supplied to AskUserQuestion through the hook');
    } else if (q.status === 'open' || q.status === 'answered') {
      this.setStatus(q, 'superseded', detail ?? 'Claude Code stopped waiting; the prompt is now in the terminal.');
      const emp = this.core.employees.get(q.employeeId);
      if (wasHeld) {
        // A high-risk call of an employee in bypass mode, held for an answer that did not come: it was refused, and
        // there is no prompt anywhere to answer later. The employee was told to wait or to ask.
        this.notify({ kind: 'permission', severity: 'warning', title: `${emp?.name ?? 'Employee'} was refused a high-risk command: nobody answered`, body: `${truncate(q.text, 300)}\n\nIt was not run. If you want it done, tell ${emp?.name ?? 'them'} to try again and answer the request when it comes.`, employeeId: q.employeeId, sessionId: q.sessionId });
        return;
      }
      // The prompt is in the terminal now — unless Claude Code itself let go of the hook (the turn was interrupted,
      // the session ended): then nothing is asked anywhere any more.
      if (q.kind === 'permission' || /no decision in time/.test(detail ?? '')) this.fellToTerminal(q, q.deliveryDetail ?? '');
    }
  }

  /** Real evidence that the runtime acted on our answer (e.g. the approved tool actually ran). */
  confirmBySignal(sessionId: string, signal: { tool?: string | null; orchestratorTool?: string | null; sessionStarted?: boolean; ran?: boolean }): void {
    for (const q of this.core.questions.filter((x) => x.sessionId === sessionId && x.status === 'delivered')) {
      if (q.channel === 'permission_hook' && signal.tool && q.tool?.name === signal.tool) this.setStatus(q, 'confirmed', q.decision === 'deny' ? 'Claude Code reported the denial to the agent' : 'The approved tool ran');
      else if (q.channel === 'ask_user_question_hook' && signal.tool === 'AskUserQuestion') this.setStatus(q, 'confirmed', 'AskUserQuestion completed with the supplied answer');
      else if (q.channel === 'mcp_tool' && (signal.orchestratorTool === 'ask_boss' || signal.orchestratorTool === 'wait_for_answer')) this.setStatus(q, 'confirmed', 'The tool result reached the agent');
      else if (q.channel === 'terminal' && q.kind === 'permission' && signal.tool) this.setStatus(q, 'confirmed', q.decision === 'deny' ? 'Claude Code went on without it' : 'The approved tool ran');
      else if (q.channel === 'auto_denied' && signal.ran && signal.tool && q.tool?.name === signal.tool) this.setStatus(q, 'confirmed', 'The allowed call ran');
      else if (q.channel === 'terminal' && signal.sessionStarted) this.setStatus(q, 'confirmed', 'The session started after the prompt was accepted');
    }
    // A colleague's answer that was returned by the tool call that waited for it: that call has now come back.
    if (signal.orchestratorTool === 'request_collaboration' || signal.orchestratorTool === 'request_help' || signal.orchestratorTool === 'wait_for_colleague') {
      const employeeId = this.core.sessions.get(sessionId)?.employeeId;
      for (const m of this.core.messages.filter((x) => x.toEmployeeId === employeeId && x.delivery.status === 'sent' && x.delivery.via === 'mcp_pull')) {
        m.delivery = { status: 'confirmed', via: 'mcp_pull', ts: nowIso(), detail: 'The tool result reached the agent' };
        this.core.put('message', m);
      }
    }
  }

  /** A session ended: nothing can be delivered to it any more. */
  sessionEnded(sessionId: string): void {
    for (const q of this.core.questions.filter((x) => x.sessionId === sessionId && (x.status === 'open' || x.status === 'answered') && x.channel !== 'mcp_tool' && x.channel !== 'system')) {
      this.supersede(q.id, 'The session ended before this was resolved.');
    }
  }

  // ─────────────────────────── messages ────────────────────────────

  /** `returned`: it is handed to the recipient as the result of a tool call of theirs that is waiting for it, so nothing is typed into their terminal. */
  sendMessage(input: { from: Message['from']; toEmployeeId: string; body: string; kind?: MessageKind; taskId?: string | null; threadId?: string | null; routineId?: string | null; returned?: boolean; files?: Message['files']; said?: string; channel?: Message['channel'] }): Message {
    const to = this.core.employees.require(input.toEmployeeId);
    // A credential somebody wrote into a message goes to the vault; the message goes on with its name there.
    const body = input.from.kind === 'system' || input.kind === 'system' ? input.body : this.eng.vault.capture(input.body, input.from.kind === 'employee' ? { kind: 'employee', id: input.from.id, name: input.from.name.replace(/ \(.*\)$/, '') } : { kind: 'owner', id: null, name: input.from.name.replace(/ \(.*\)$/, '') }, [to.name]).text;
    input = { ...input, body };
    const msg: Message = {
      id: newId(),
      kind: input.kind ?? 'chat',
      from: input.from,
      toEmployeeId: to.id,
      body: input.body,
      taskId: input.taskId ?? null,
      threadId: input.threadId ?? null,
      delivery: input.returned ? { status: 'sent', via: 'mcp_pull', ts: nowIso(), detail: RETURNED } : { status: 'queued', via: null, ts: nowIso(), detail: null },
      createdAt: nowIso(),
      readAt: input.returned ? nowIso() : null,
      ...(input.routineId ? { routineId: input.routineId } : {}),
      ...(input.files?.length ? { files: input.files, said: input.said ?? input.body } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
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
    if (!input.returned) this.enqueueMessage(msg, true);
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
        // A run of a routine, and a request whose sender cannot go on without the answer, start the session of someone who has none.
        wake: !!msg.routineId || (msg.kind === 'collab_request' && !!collab?.waited),
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

  /** `waited`: the one who asks cannot go on without the answer and waits for it; the colleague is told so, and is started for it if they have no session. */
  requestCollaboration(from: Employee, toRef: string | Employee, summary: string, detail: string, opts: { waited?: boolean } = {}): CollabRequest {
    const to = typeof toRef === 'string' ? this.resolveTeammate(from, toRef) : toRef;
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
      ...(opts.waited ? { waited: true } : {}),
    };
    this.core.put('collab', collab);
    this.core.event({
      type: 'agent.collaboration_requested',
      source: 'mcp',
      summary: `${from.name} asked ${to.name}${collab.waited ? ' and is waiting for the answer' : ''}: ${truncate(summary, 120)}`,
      employeeId: from.id,
      taskId: collab.taskId,
      projectId: collab.projectId,
      correlationId: collab.id,
      data: { collabId: collab.id, fromEmployeeId: from.id, toEmployeeId: to.id, ...(collab.waited ? { waited: true } : {}) },
    });
    this.sendMessage({ from: { kind: 'employee', id: from.id, name: `${from.name} (${from.title})` }, toEmployeeId: to.id, body: `${summary}\n${detail}`.trim(), kind: 'collab_request', taskId: collab.taskId, threadId: collab.id });
    return collab;
  }

  /**
   * A colleague's answer to a request was handed to the one who asked as the result of a tool call (they came back
   * to wait for an answer that was already there): the copy queued for their terminal is not needed any more.
   */
  responseReturnedByTool(requestId: string, employeeId: string): void {
    for (const m of this.core.messages.filter((x) => x.threadId === requestId && x.toEmployeeId === employeeId && x.delivery.status === 'queued')) {
      this.dropQueued((d) => d.ref.kind === 'message' && d.ref.id === m.id);
      m.delivery = { status: 'sent', via: 'mcp_pull', ts: nowIso(), detail: RETURNED };
      m.readAt = nowIso();
      this.core.put('message', m);
    }
  }

  /** Answer a request. The result says whether the one who asked was waiting in a held tool call and has the answer now. */
  respondToRequest(responder: Employee, requestId: string, action: CollabRequest['status'], note: string): { collab: CollabRequest; unblocked: boolean } {
    const collab = this.core.collabs.get(requestId) ?? this.core.collabs.find((c) => c.id.startsWith(requestId));
    if (!collab) throw new EngineError(`no collaboration request "${requestId}"`);
    if (collab.toEmployeeId !== responder.id) throw new EngineError('that request was not addressed to you');
    if (collab.status !== 'open') throw new EngineError(`that request was already answered (${collab.status})`);
    const requester = this.core.employees.require(collab.fromEmployeeId);
    // Is a tool call of the one who asked being held open for this answer? Then the answer goes back through it.
    const held = this.eng.waits.holding(collab.id);
    collab.status = action;
    collab.response = note;
    collab.resolvedAt = nowIso();
    collab.responderTaskId = this.eng.tasks.currentTask(responder.id)?.id ?? null;
    // "A separate task" becomes one on the board before the answer is recorded: the answer names it.
    if (action === 'new_task' && collab.projectId) {
      const project = this.core.projects.get(collab.projectId);
      // (Only where the responder may take work at all: not in a project on the other side of the line between the
      // shared office and a member's own computer.)
      if (project && this.eng.tasks.canSee(responder, { projectId: project.id } as Parameters<typeof this.eng.tasks.canSee>[1])) {
        collab.createdTaskId = this.eng.tasks.createTask(
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
        ).id;
      }
    }
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
      returned: held,
    });
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
    // Everything about the answer is on record: whoever was waiting for it has it now.
    return { collab, unblocked: this.eng.waits.answered(collab) };
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
      if (m?.kind === 'collab_request' && this.core.collabs.get(m.threadId)?.waited) return `a request from ${m.from.name}, who is waiting for the answer`;
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
    this.heldBack(hostId);
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
    const flying = this.inflight.get(employeeId);
    // (What was typed and not acknowledged yet is looked at also when nothing else waits behind it: before, it was
    // only noticed when the next thing came — and a prompt that stood unsent in a terminal stood there until then.)
    if (!this.queue.get(employeeId)?.length && !flying) return;
    const session = this.core.runningSessionOf(employeeId);
    if (!session) {
      const waiting = this.queue.get(employeeId);
      return waiting?.length ? this.wakeFor(employeeId, waiting) : undefined;
    }
    if (flying) {
      // One prompt at a time: wait for the hook that confirms it (or give up waiting).
      if (Date.now() - (flying.sentAt ?? 0) < this.core.timings.deliveryConfirmMs) return this.schedulePump(employeeId, 1000);
      this.inflight.delete(employeeId);
      if (await this.recover(flying, session)) return;
      this.markUnconfirmed(flying);
    }
    const list = this.queue.get(employeeId);
    if (!list?.length) return;
    if (this.blockedReason(session)) return;
    // A session that was only just started: what is typed before its input box is up arrives without its Enter.
    // (Only where the office sees the screen; and not for ever — a terminal it cannot read is typed into as before.)
    if (session.mode !== 'managed_sdk' && session.capabilities.hooks && Date.now() - Date.parse(session.startedAt) < 20_000) {
      const screen = this.core.gateway.screens.get(session.id);
      if (screen && !inputBox(screen.lines)) return this.schedulePump(employeeId, 700);
    }
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
      // The host did not answer the send — its agent was restarted, the link dropped — but the session may have
      // taken the prompt all the same, and said so with its hook while the answer was awaited. (The host answers
      // only once it has seen the prompt leave the input box, several seconds after it was typed.) What Claude Code
      // acknowledged is never sent again: sent twice, the employee does the work twice.
      if (this.taken.has(d)) return this.schedulePump(employeeId, 200);
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
    this.taken.add(d);
    this.applyState(d, 'confirmed', d.via, detail);
  }

  /**
   * A prompt was typed into a session and Claude Code never acknowledged it, and the session is between turns: it
   * did not take it. Where the office can see the terminal it looks: the text standing in the input box is
   * submitted (Enter); a box without it means the paste itself was lost, and it is typed again. Twice at most;
   * never at a dialog, never while a person holds the keyboard. Returns whether something was done.
   */
  private async recover(d: Delivery, session: AgentSession): Promise<boolean> {
    if (d.via !== 'terminal_paste' || !session.capabilities.hooks || session.mode === 'managed_sdk' || session.status !== 'running' || session.inTurn !== false) return false;
    if (this.core.gateway.isHumanControlled(session.id) || this.core.gateway.isPaused(session.id) || !this.core.agents.isOnline(session.hostId)) return false;
    const screen = this.core.gateway.screens.get(session.id);
    const box = screen ? inputBox(screen.lines) : null;
    const name = this.core.employees.get(d.employeeId)?.name ?? 'employee';
    if (!box || (d.recovered ?? 0) >= 2) {
      // Nothing more the office can do from here: said where a person sees it, once.
      if ((d.recovered ?? 0) >= 2 || box === null) this.notify({ kind: 'info', severity: 'warning', title: `${name} has not taken what was typed to them`, body: `${this.whatFor(d)} was typed into ${name}'s terminal and Claude Code did not acknowledge it${(d.recovered ?? 0) ? `, also after ${d.recovered} more ${d.recovered === 1 ? 'try' : 'tries'}` : ''}. Open their terminal and look.`, employeeId: d.employeeId, sessionId: session.id, taskId: d.ref.kind === 'task' ? d.ref.id : null });
      return false;
    }
    d.recovered = (d.recovered ?? 0) + 1;
    if (boxHolds(box, d.text)) {
      try {
        await this.core.agents.rpc(session.hostId, { method: 'session.keys', params: { sessionId: session.id, keys: ['Enter'] } });
      } catch {
        return false;
      }
      d.sentAt = Date.now();
      this.inflight.set(d.employeeId, d);
      this.core.log('info', `delivery ${d.marker}:${d.markerId} to ${name} stood in the input box unsent: submitted`);
      this.core.event({ type: 'terminal.resubmitted', source: 'server', summary: `What was typed to ${name} stood in their terminal unsent: the office pressed Enter`, employeeId: d.employeeId, sessionId: session.id, taskId: d.ref.kind === 'task' ? d.ref.id : null, data: { marker: d.marker, quiet: true } });
      this.schedulePump(d.employeeId, this.core.timings.deliveryConfirmMs + 200);
      return true;
    }
    // Not in the box: it never arrived. Typed again, ahead of whatever else waits.
    this.queue.set(d.employeeId, [d, ...(this.queue.get(d.employeeId) ?? [])]);
    this.core.log('info', `delivery ${d.marker}:${d.markerId} to ${name} did not arrive: typed again`);
    this.schedulePump(d.employeeId, 300);
    return true;
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
