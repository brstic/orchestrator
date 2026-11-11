import type { AgentSession, Employee, HookPayload, Question, QuestionOption, RawHookEvent, Task } from '@orchestrator/contracts';
import { containsKnownSecret, redactSecrets, truncate } from '@orchestrator/contracts';
import { describeTool, interpretHook } from '@orchestrator/integrations';
import type { Engine } from './engine.ts';
import { nudgePrompt } from './prompts.ts';

interface SessionRuntime {
  /** A test run failed and none has passed since. */
  debugging: boolean;
  activeSubagents: number;
  /** A PreToolUse the host's policy gate escalated; the PermissionRequest that follows refers to it. */
  highRisk: { tool: string; input: string } | null;
  /** Going in circles: how often each failure (the same tool, the same error) has come back during the task in hand. */
  failures?: { taskId: string | null; counts: Map<string, number> };
}

const NUDGE_LIMIT: Record<string, number> = { restricted: 0, supervised: 0, standard: 1, autonomous: 3, auto: 3 };

/**
 * Receives raw Claude Code hook invocations forwarded by host agents and turns
 * them into normalized events, employee activity and — for blocking hooks —
 * decisions.
 *
 * Processing is idempotent: hosts deliver at least once, each raw hook has a
 * unique id, and a redelivered hook is acknowledged without being re-applied.
 */
export class HookReceiver {
  private eng: Engine;
  private rt = new Map<string, SessionRuntime>();

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  private runtime(sessionId: string): SessionRuntime {
    let r = this.rt.get(sessionId);
    if (!r) this.rt.set(sessionId, (r = { debugging: false, activeSubagents: 0, highRisk: null }));
    return r;
  }

  /** Non-blocking hook. Returns true when the host may drop it from its outbox. */
  onHook(hostId: string, raw: RawHookEvent): boolean {
    if (!this.core.store.markProcessed(`hook:${raw.id}`)) return true;
    try {
      this.process(hostId, raw);
    } catch (e) {
      this.core.log('error', `hook ${raw.payload?.hook_event_name}: ${(e as Error).stack}`);
    }
    return true;
  }

  /** Blocking hook: the host is holding Claude Code's hook open for our answer. */
  onHookRequest(hostId: string, requestId: string, raw: RawHookEvent): void {
    const respond = (output: Record<string, unknown> | null) => this.core.agents.respondHook(hostId, requestId, output);
    if (!this.core.store.markProcessed(`hook:${raw.id}`)) return void respond(null);
    let ctx: ReturnType<HookReceiver['process']>;
    try {
      ctx = this.process(hostId, raw);
    } catch (e) {
      this.core.log('error', `hook request ${raw.payload?.hook_event_name}: ${(e as Error).stack}`);
      return void respond(null);
    }
    if (!ctx) return void respond(null);
    const { session, employee, payload } = ctx;
    switch (payload.hook_event_name) {
      case 'PermissionRequest': {
        const tool = payload.tool_name ?? 'tool';
        const what = describeTool(tool, payload.tool_input, payload.cwd);
        const rt = this.runtime(session.id);
        const highRisk = payload.orch_policy === 'high_risk' || (!!rt.highRisk && rt.highRisk.tool === tool && rt.highRisk.input === JSON.stringify(payload.tool_input ?? null));
        rt.highRisk = null;
        const q = this.eng.comms.createQuestion({
          kind: 'permission',
          channel: 'permission_hook',
          employee,
          session,
          text: `${employee?.name ?? 'This session'} wants to run: ${what}`,
          context: this.permissionContext(payload),
          why: highRisk ? 'This command matches a high-risk pattern, so it always needs your approval.' : `Claude Code's permission rules do not pre-approve this action for ${employee?.name ?? 'this session'} (${session.permissionMode ?? 'current'} mode).`,
          options: [
            { label: 'Allow', description: 'Let this one action run' },
            { label: 'Deny', description: 'Refuse it; the agent is told and continues without it' },
          ],
          tool: { name: tool, input: this.trimInput(payload.tool_input) },
          quietEvent: true,
        });
        this.eng.comms.holdHook(q, { hostId, requestId, kind: 'permission', toolInput: payload.tool_input });
        return;
      }
      case 'PreToolUse': {
        if (payload.tool_name !== 'AskUserQuestion') return void respond(null);
        const parts = this.askUserParts(payload.tool_input);
        if (!parts.length) return void respond(null);
        const q = this.eng.comms.createQuestion({
          kind: 'question',
          channel: 'ask_user_question_hook',
          employee,
          session,
          text: parts.length === 1 ? parts[0]!.question : `${employee?.name ?? 'This session'} has ${parts.length} questions`,
          context: parts.length > 1 ? parts.map((p) => `• ${p.question}`).join('\n') : '',
          why: 'Claude Code asked this through its AskUserQuestion tool and is waiting for the answer.',
          options: parts.length === 1 ? parts[0]!.options : [],
          parts,
        });
        this.eng.comms.holdHook(q, { hostId, requestId, kind: 'ask_user', toolInput: payload.tool_input });
        return;
      }
      case 'Stop': {
        const output = this.stopDecision(session, employee, payload, requestId);
        respond(output);
        if (!output) this.afterTurn(session, employee, payload);
        return;
      }
      default:
        return void respond(null);
    }
  }

  private trimInput(input: any): unknown {
    if (!input || typeof input !== 'object') return input ?? null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? truncate(v, 4000) : v;
    return out;
  }

  private permissionContext(payload: HookPayload): string {
    const input = payload.tool_input ?? {};
    const lines: string[] = [];
    if (typeof input.command === 'string') lines.push(`Command:\n${truncate(input.command, 2000)}`);
    if (typeof input.description === 'string') lines.push(`Stated purpose: ${input.description}`);
    if (input.file_path) lines.push(`File: ${input.file_path}`);
    if (typeof input.old_string === 'string' || typeof input.new_string === 'string') lines.push(`Change:\n- ${truncate(String(input.old_string ?? ''), 600)}\n+ ${truncate(String(input.new_string ?? ''), 600)}`);
    if (typeof input.content === 'string') lines.push(`Content (${input.content.length} chars):\n${truncate(input.content, 800)}`);
    if (typeof input.url === 'string') lines.push(`URL: ${input.url}`);
    if (payload.cwd) lines.push(`Working directory: ${payload.cwd}`);
    return lines.join('\n\n');
  }

  private askUserParts(input: any): Array<{ question: string; header: string | null; options: QuestionOption[]; multiSelect: boolean }> {
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    return questions
      .filter((q: any) => q && typeof q.question === 'string')
      .map((q: any) => ({
        question: q.question as string,
        header: typeof q.header === 'string' ? q.header : null,
        options: (Array.isArray(q.options) ? q.options : []).filter((o: any) => o && typeof o.label === 'string').map((o: any) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : undefined })),
        multiSelect: q.multiSelect === true,
      }));
  }

  /**
   * Stop hook: Claude finished a turn. We may keep it going — to hand over
   * queued messages/tasks without touching the terminal, or to nudge an
   * autonomous employee who stopped with their task unfinished.
   */
  private stopDecision(session: AgentSession, employee: Employee | null, payload: HookPayload, requestId: string): Record<string, unknown> | null {
    if (!employee) return null;
    const batch = this.eng.comms.takeForStopHook(employee.id, requestId);
    if (batch) return { decision: 'block', reason: batch };
    // stop_hook_active only says "a Stop hook already continued this chain". Runaway loops are
    // prevented by the per-task nudge budget below, which is finite at every autonomy level.
    const task = this.eng.tasks.currentTask(employee.id);
    if (!task || task.delivery.status !== 'confirmed') return null;
    if (this.core.gateway.isHumanControlled(session.id) || this.core.gateway.isPaused(session.id)) return null;
    // Cut off from the office's tools: it could not complete, ask or report whatever it is told. It is started again instead.
    if (this.eng.sessions.cutOff(session.id)) return null;
    // Stopped because a colleague has not answered or finished yet: there is nothing to be nudged on with.
    if (session.waitingOn) return null;
    if (this.core.questions.find((q) => q.employeeId === employee.id && (q.status === 'open' || q.status === 'answered') && q.channel !== 'system')) return null;
    const limit = NUDGE_LIMIT[employee.autonomy] ?? 0;
    if (task.nudges >= limit) return null;
    task.nudges++;
    this.core.put('task', task);
    this.core.event({ type: 'task.updated', source: 'server', summary: `Orchestrator nudged ${employee.name} to continue ${task.key} (${task.nudges}/${limit})`, taskId: task.id, projectId: task.projectId, employeeId: employee.id, sessionId: session.id, data: { key: task.key, nudge: task.nudges, quiet: true } });
    return { decision: 'block', reason: nudgePrompt(task) };
  }

  /** What an employee is doing once a turn has genuinely ended. */
  private afterTurn(session: AgentSession, employee: Employee | null, payload: HookPayload): void {
    session.inTurn = false;
    this.core.put('session', session);
    if (employee && this.eng.sessions.cutOff(session.id)) void this.eng.sessions.reconnect(employee.id);
    if (!employee) {
      this.eng.sessions.setActivity(session, 'idle', null);
      return;
    }
    const task: Task | undefined = this.eng.tasks.currentTask(employee.id);
    // Only questions this session itself is waiting on; Orchestrator's own questions to the owner
    // (merge conflicts, priorities) do not make the employee "waiting".
    const openQuestion = this.core.questions.find((q) => q.employeeId === employee.id && q.status === 'open' && q.channel !== 'system');
    if (session.activity === 'task_complete' || session.activity === 'blocked' || session.activity === 'paused') {
      // Keep the more specific state that a real report put there.
    } else if (openQuestion) {
      this.eng.sessions.setActivity(session, openQuestion.kind === 'permission' ? 'needs_approval' : 'waiting_answer', truncate(openQuestion.text, 120));
    } else if (session.waitingOn) {
      // The turn ended while what they asked a colleague for has not come: they are waiting for that colleague.
      this.eng.sessions.setActivity(session, 'waiting_input', this.eng.waits.detail(session.waitingOn));
    } else if (task && task.delivery.status === 'confirmed') {
      // Stopped mid-task without completing or asking through Orchestrator: it is waiting on something.
      this.eng.sessions.setActivity(session, 'waiting_input', truncate(String(payload.last_assistant_message ?? '').replace(/\s+/g, ' '), 140) || `Stopped while working on ${task.key}`);
    } else {
      this.eng.sessions.setActivity(session, 'idle', null);
    }
    this.eng.foreman.onTurnFinished(employee.id);
    this.eng.comms.schedulePump(employee.id);
    this.eng.tasks.schedule();
  }

  private process(hostId: string, raw: RawHookEvent): { session: AgentSession; employee: Employee | null; payload: HookPayload } | null {
    const payload = raw.payload;
    if (!payload || typeof payload.hook_event_name !== 'string' || !raw.sessionId) return null;
    const session = this.core.sessions.get(raw.sessionId);
    if (!session || session.hostId !== hostId) return null;
    const employee = this.core.employees.get(session.employeeId) ?? null;
    const task = employee ? this.eng.tasks.currentTask(employee.id) : undefined;
    const rt = this.runtime(session.id);
    const interp = interpretHook(payload, { employeeName: employee?.name ?? session.tmuxSession, debugging: rt.debugging, taskKind: task?.kind ?? null, activeSubagents: rt.activeSubagents });

    session.lastEventAt = raw.ts;
    if (payload.session_id) session.claudeSessionId = payload.session_id;
    if (payload.permission_mode) session.permissionMode = payload.permission_mode;
    if (!session.capabilities.hooks) session.capabilities = { ...session.capabilities, hooks: true, structuredApproval: true, structuredMessaging: true };
    if (session.status === 'starting') session.status = 'running';
    switch (payload.hook_event_name) {
      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionRequest':
      case 'SubagentStart':
        session.inTurn = true;
        this.eng.sessions.noteTurn(session.id);
        break;
      case 'SessionStart':
      case 'SessionEnd':
        session.inTurn = false;
        break;
      case 'Notification':
        // Claude Code only sends idle_prompt while it sits at an empty prompt.
        if (payload.notification_type === 'idle_prompt') session.inTurn = false;
        break;
    }

    interp.events.forEach((ev, i) => {
      this.core.event({
        id: `${raw.id}:${i}`,
        ts: raw.ts,
        type: ev.type,
        source: 'hook',
        summary: ev.summary,
        hostId,
        sessionId: session.id,
        employeeId: employee?.id ?? null,
        taskId: task?.id ?? null,
        projectId: task?.projectId ?? employee?.projectId ?? null,
        correlationId: payload.tool_use_id ?? null,
        data: { ...ev.data, hook: payload.hook_event_name, ...(ev.quiet ? { quiet: true } : {}) },
      });
    });

    if (payload.hook_event_name === 'PreToolUse') rt.highRisk = payload.orch_policy === 'high_risk' ? { tool: payload.tool_name ?? '', input: JSON.stringify(payload.tool_input ?? null) } : null;
    if (payload.hook_event_name === 'SubagentStart') rt.activeSubagents++;
    if (payload.hook_event_name === 'SubagentStop') rt.activeSubagents = Math.max(0, rt.activeSubagents - 1);
    if (interp.sessionStarted || interp.sessionEnded) rt.activeSubagents = 0;

    // The same failure again and again is not work: the employee is told at the third, the owner at the sixth.
    const failure = employee ? failureKey(payload) : null;
    if (employee && failure) {
      if (!rt.failures || rt.failures.taskId !== (task?.id ?? null)) rt.failures = { taskId: task?.id ?? null, counts: new Map() };
      const n = (rt.failures.counts.get(failure.key) ?? 0) + 1;
      rt.failures.counts.set(failure.key, n);
      if (rt.failures.counts.size > 60) rt.failures.counts.delete(rt.failures.counts.keys().next().value!);
      if (n === LOOP_NOTE_AT) {
        this.eng.comms.sendMessage({ from: { kind: 'system', id: null, name: 'Orchestrator' }, kind: 'system', toEmployeeId: employee.id, taskId: task?.id ?? null, body: `The same thing has now failed ${n} times: ${failure.what}. Trying it again will fail again. Stop, read the error in full, and change the approach — or, if you cannot get past it, say so with report_blocker.` });
      } else if (n === LOOP_ALERT_AT) {
        this.core.event({ type: 'agent.tool_failed', source: 'server', summary: `${employee.name} keeps hitting the same failure (${n} times): ${failure.what}`, employeeId: employee.id, sessionId: session.id, taskId: task?.id ?? null, projectId: task?.projectId ?? employee.projectId ?? null, data: { looping: true, times: n, what: failure.what } });
        this.eng.comms.notify({ kind: 'blocked', severity: 'warning', title: `${employee.name} is going in circles`, body: `The same failure has come back ${n} times${task ? ` on ${task.key}` : ''}: ${failure.what}. They were told to change approach at the third. Look at their terminal, or tell them what to do.`, employeeId: employee.id, sessionId: session.id, taskId: task?.id ?? null, projectId: task?.projectId ?? employee.projectId ?? null });
      }
    }

    if (interp.testOutcome === 'failed') {
      rt.debugging = true;
      if (employee && !this.core.notifications.find((n) => !n.resolvedAt && n.kind === 'test_failure' && n.employeeId === employee.id && n.sessionId === session.id)) {
        this.eng.comms.notify({
          kind: 'test_failure',
          severity: 'warning',
          title: `${employee.name}'s tests failed`,
          body: truncate(String(payload.tool_input?.command ?? ''), 200),
          employeeId: employee.id,
          sessionId: session.id,
          taskId: task?.id ?? null,
          projectId: task?.projectId ?? null,
        });
      }
    } else if (interp.testOutcome === 'passed') {
      rt.debugging = false;
      this.eng.comms.resolveNotifications((n) => n.kind === 'test_failure' && n.sessionId === session.id);
    }

    if (interp.deployment) {
      const company = this.core.company;
      company.deployments++;
      if (!interp.deployment.ok) company.deploymentsFailed++;
      else if (interp.deployment.kind === 'release') company.releases++;
      this.core.saveCompany();
      this.eng.tasks.checkMilestones();
    }
    // Claude Code refused an action (a deny rule, or auto mode's own safety check): the owner should know what was tried.
    if (payload.hook_event_name === 'PermissionDenied' && employee) {
      const what = truncate(redactSecrets(typeof payload.tool_input?.command === 'string' ? payload.tool_input.command : `${payload.tool_name ?? 'a tool'} ${JSON.stringify(payload.tool_input ?? {})}`), 300);
      this.eng.comms.securityAlert({
        key: `denied:${session.id}:${what}`,
        title: `${employee.name} was refused an action`,
        body: `Claude Code did not allow: ${what}${payload.reason ? ` — ${truncate(String(payload.reason), 200)}` : ''}`,
        employeeId: employee.id,
        sessionId: session.id,
        projectId: task?.projectId ?? employee.projectId ?? null,
        data: { tool: payload.tool_name ?? null },
      });
      // Claude Code's own check (it gives its reason): nobody in the office decided this, so the owner is asked
      // whether to allow it once — the employee cannot get past it any other way, and should not.
      this.askAboutRefusal(session, employee, task ?? null, payload);
    }
    // Something shaped like a credential went through this session: it is redacted in the office's records, and the owner is told.
    const seen = [payload.prompt, payload.tool_input?.command, payload.last_assistant_message].filter((x): x is string => typeof x === 'string' && x.length > 0);
    // What a tool returned is looked at too (a file with keys in it that was read, a key a command printed).
    const returned = textOf(payload.tool_response).slice(0, 40_000);
    // Whatever it was, it is kept: a credential that only ever lived in a terminal's scrollback is lost with it.
    const kept = employee ? [...seen, returned].flatMap((text) => (text ? this.eng.vault.noticed(text, { kind: 'employee', id: employee.id, name: employee.name }, [this.core.projects.get(task?.projectId ?? employee.projectId)?.name ?? '']) : [])) : [];
    if (employee && (seen.some(containsKnownSecret) || kept.length)) {
      this.eng.comms.securityAlert({
        key: `secret:${session.id}`,
        title: `Something that looks like a secret appeared in ${employee.name}'s session`,
        body: 'A value in a known credential format (an API key, a token or a private key) was seen in a prompt, a command or a reply. It is redacted in the office\'s records; if it is a real secret, consider rotating it.' + (kept.length ? ` It was put in the vault as ${kept.map((n) => `"${n}"`).join(', ')}.` : ''),
        employeeId: employee.id,
        sessionId: session.id,
        projectId: task?.projectId ?? employee.projectId ?? null,
      });
    }

    if (employee) for (const m of interp.markers) this.eng.comms.confirmMarker(employee.id, m.kind, m.id);

    // Any hook after a permission prompt proves the prompt was dealt with (possibly in the terminal).
    if (payload.hook_event_name === 'PostToolUse' || payload.hook_event_name === 'PostToolUseFailure' || payload.hook_event_name === 'PermissionDenied') {
      this.eng.comms.confirmBySignal(session.id, { tool: payload.tool_name ?? null, orchestratorTool: interp.orchestratorTool, ran: payload.hook_event_name === 'PostToolUse' });
      this.eng.comms.resolveNotifications((n) => n.kind === 'permission' && n.sessionId === session.id && !n.questionId);
      // A prompt the office was asking about through the terminal: the session has moved past it.
      for (const q of this.core.questions.filter((x) => x.sessionId === session.id && x.status === 'open' && x.kind === 'permission' && x.channel === 'terminal')) this.eng.comms.supersede(q.id, 'The prompt was answered in the terminal.');
    }
    if (interp.sessionStarted) {
      this.eng.comms.confirmBySignal(session.id, { sessionStarted: true });
      for (const q of this.core.questions.filter((x) => x.sessionId === session.id && x.kind === 'trust_prompt' && x.status === 'open')) {
        this.eng.comms.supersede(q.id, 'The prompt was accepted in the terminal.');
      }
    }

    if (interp.activity) {
      const wait = session.waitingOn;
      const toolHook = payload.hook_event_name === 'PreToolUse' || payload.hook_event_name === 'PostToolUse' || payload.hook_event_name === 'PostToolUseFailure';
      if (session.activity === 'paused' && this.core.gateway.isPaused(session.id)) {
        // A paused employee stays visibly paused until the owner resumes them.
      } else if (wait?.held && toolHook) {
        // A call is being held open for a colleague: hooks of tool calls that arrive meanwhile (they travel separately
        // from the call itself) do not change what is shown. The call sets the state again when it returns.
      } else if (wait && interp.activity.state === 'waiting_input' && !interp.activity.detail) {
        // At the prompt while a colleague has not answered or finished yet: waiting, and for whom.
        this.eng.sessions.setActivity(session, 'waiting_input', this.eng.waits.detail(wait));
      } else {
        this.eng.sessions.setActivity(session, interp.activity.state, interp.activity.detail);
      }
    }
    this.core.put('session', session);

    if (interp.sessionEnded) this.eng.comms.sessionEnded(session.id);
    if (interp.sessionStarted && employee) {
      this.eng.comms.schedulePump(employee.id, 600);
      this.eng.tasks.schedule();
    }
    if (payload.hook_event_name === 'Notification' && payload.notification_type === 'idle_prompt' && employee) {
      this.eng.comms.schedulePump(employee.id);
      this.eng.tasks.schedule();
    }
    // A file this session wrote: remembered on its task, so that in a shared folder its uncommitted work is told from a colleague's.
    if (payload.hook_event_name === 'PostToolUse' && task && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(String(payload.tool_name ?? ''))) {
      const file = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
      if (typeof file === 'string' && file) this.eng.tasks.noteTouched(task, file);
    }
    // One of the office's own tools could not be reached from this session and Claude Code has given the connection
    // up ("not connected"): the session is started again when this turn ends. A single refused connection is not
    // that — the office is away for some seconds at every update, and a call made just then fails on its own.
    if (payload.hook_event_name === 'PostToolUseFailure' && /^mcp__orchestrator__/.test(String(payload.tool_name ?? '')) && /not connected/i.test(String(payload.error ?? ''))) this.eng.sessions.onOfficeUnreachable(session);
    // Claude refused the turn for the account's limit: its people go to another account, if the machine has one.
    if (payload.hook_event_name === 'StopFailure' && /rate.?limit|usage.?limit|billing/i.test(String(payload.error ?? payload.error_details ?? payload.message ?? ''))) this.eng.sessions.onLimitHit(session, String(payload.error ?? payload.message ?? 'rate_limit'));
    // A Stop that arrived through the non-blocking path (host had no server link at the time).
    if (interp.turnFinished && payload.hook_event_name === 'Stop' && !this.isRequest(raw)) this.afterTurn(session, employee, payload);
    return { session, employee, payload };
  }

  /**
   * An action Claude Code refused by itself becomes a request to the owner: allow it once, or leave it refused.
   * Once per action while it is open; not for something the owner has just refused, and not without end for one
   * employee (somebody who is refused again and again has a different problem).
   */
  private askAboutRefusal(session: AgentSession, employee: Employee, task: Task | null, payload: HookPayload): void {
    const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
    if (!reason) return;
    const tool = String(payload.tool_name ?? 'tool');
    const same = (q: Question) => q.tool?.name === tool && JSON.stringify(q.tool?.input ?? null) === JSON.stringify(this.trimInput(payload.tool_input));
    const mine = this.core.questions.filter((q) => q.sessionId === session.id && q.kind === 'permission');
    // The owner's own "no" a moment ago (through the hook or at the terminal) is not asked about again.
    if (mine.some((q) => q.decision === 'deny' && same(q) && !!q.answeredAt && Date.now() - Date.parse(q.answeredAt) < 60_000)) return;
    const asked = mine.filter((q) => q.channel === 'auto_denied');
    const again = asked.find((q) => same(q) && (q.status === 'open' || q.status === 'delivered'));
    if (again) {
      // Allowed once already, and refused again: the owner's word did not get it past Claude Code's check.
      if (again.status === 'delivered' && again.decision === 'allow') {
        again.status = 'failed';
        again.deliveryDetail = 'Claude Code refused it again although you allowed it. Its own check cannot be overruled from the office: do it at the workstation yourself, or put this employee on Standard (where your approval is the decision).';
        this.core.put('question', again);
        this.eng.comms.notify({ kind: 'permission', severity: 'warning', title: `${employee.name} was refused again`, body: again.deliveryDetail, employeeId: employee.id, sessionId: session.id });
      }
      return;
    }
    if (asked.filter((q) => Date.now() - Date.parse(q.createdAt) < 60 * 60_000).length >= 8) return;
    const what = describeTool(tool, payload.tool_input, payload.cwd);
    this.eng.comms.createQuestion({
      kind: 'permission',
      channel: 'auto_denied',
      employee,
      session,
      text: `Claude Code refused ${employee.name}'s action: ${what}`,
      context: `${this.permissionContext(payload)}\n\nReason given: ${truncate(redactSecrets(reason), 400)}`,
      why: `${employee.name} runs on Auto: Claude Code's own safety check decides what is allowed, and it refused this. Nothing was run. You can allow exactly this call once; the employee is then told to run it again.`,
      options: [
        { label: 'Allow', description: 'Let exactly this call run, once', consequence: 'The employee is told to run it again; an identical call is let through once in the next ten minutes.' },
        { label: 'Deny', description: 'Leave it refused', consequence: 'The employee is told to find another way or to report a blocker.' },
      ],
      tool: { name: tool, input: this.trimInput(payload.tool_input) },
      quietEvent: true,
    });
  }

  private requestIds = new Set<string>();

  private isRequest(raw: RawHookEvent): boolean {
    return this.requestIds.has(raw.id);
  }

  /** Called by the hub before onHookRequest so `process` knows a decision path will follow. */
  markRequest(raw: RawHookEvent): void {
    this.requestIds.add(raw.id);
    if (this.requestIds.size > 2000) this.requestIds = new Set([...this.requestIds].slice(-500));
  }

  forgetSession(sessionId: string): void {
    this.rt.delete(sessionId);
  }
}

/** Every piece of text in what a tool returned, one per line (so that a file's lines are still lines). */
function textOf(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || depth > 5) return '';
  return (Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)).map((v) => textOf(v, depth + 1)).filter(Boolean).join('\n');
}

/** After this many returns of one failure the employee is told; after this many, the owner. */
const LOOP_NOTE_AT = 3;
const LOOP_ALERT_AT = 6;

/**
 * What identifies a failure that keeps coming back: the tool, the command and the first line of the error, with
 * numbers taken out (a line number, a port, a duration differ from one try to the next; the failure is the same).
 * Null when the hook is not a failed tool call.
 */
export function failureKey(payload: { hook_event_name?: string; tool_name?: string; tool_input?: any; tool_response?: any; error?: unknown; is_interrupt?: unknown }): { key: string; what: string } | null {
  const ev = payload.hook_event_name;
  const r = payload.tool_response;
  const failed =
    (ev === 'PostToolUseFailure' && payload.is_interrupt !== true) ||
    (ev === 'PostToolUse' && !!r && typeof r === 'object' && ((typeof r.exitCode === 'number' && r.exitCode !== 0) || (typeof r.exit_code === 'number' && r.exit_code !== 0) || r.is_error === true || r.isError === true));
  if (!failed) return null;
  const tool = String(payload.tool_name ?? 'tool');
  // Calls into the office itself are answered in words ("Not complete: …"); repeating those is a conversation, not a loop.
  if (tool.startsWith('mcp__orchestrator')) return null;
  const firstLine = (text: string) => text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const error = firstLine(typeof payload.error === 'string' ? payload.error : textOf(r && typeof r === 'object' ? (r.stderr ?? r.error ?? r) : r));
  const command = typeof payload.tool_input?.command === 'string' ? payload.tool_input.command : String(payload.tool_input?.file_path ?? '');
  const norm = (s: string) => s.toLowerCase().replace(/0x[0-9a-f]+|\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 140);
  const what = redactSecrets(`${tool === 'Bash' ? `\`${truncate(command.replace(/\s+/g, ' '), 80)}\`` : tool}${error ? ` — ${truncate(error, 140)}` : ''}`);
  return { key: `${tool}|${norm(command)}|${norm(error)}`, what };
}

