import type { AgentSession, Employee, Task } from '@orchestrator/contracts';
import { ACTIVITY_LABEL, FOR_OWNERS, reviewByOf, truncate } from '@orchestrator/contracts';
import type { McpServerOptions, McpToolHandler } from '@orchestrator/integrations';
import { BOARD_TOOLS, FILE_TOOLS, LEAD_TOOLS, MEMORY_TOOLS, ORCHESTRATOR_TOOLS, VAULT_TOOLS } from '@orchestrator/integrations';
import type { Engine } from './engine.ts';
import { LEAD_ROLE } from '@orchestrator/contracts';
import { answerLine } from './prompts.ts';
import { GOAL_IDLE_TURNS } from './goals.ts';
import { RELEVANT } from './memory.ts';

/** Who is calling: resolved from the session's bearer token, never from tool arguments. */
export interface McpContext {
  session: AgentSession;
  employee: Employee;
  /** Aborted when the caller closes the connection before the tool has answered (a held call that nobody listens to any more). */
  signal?: AbortSignal;
}

function describeTask(eng: Engine, t: Task): string {
  const core = eng.core;
  const project = core.projects.get(t.projectId);
  const deps = t.dependsOn.map((id) => core.tasks.get(id)).filter((x): x is Task => !!x);
  const parts = eng.talk.partsOf(t);
  const thread = eng.talk.threadText(t, 15);
  const lines = [
    `${t.key}: ${t.title}`,
    `Status: ${t.status}${t.status === 'BACKLOG' && !t.released ? ' (not released)' : ''} · Kind: ${t.kind} · Priority: ${t.priority}`,
    `Assigned to: ${core.employees.get(t.assigneeId)?.name ?? 'nobody'}`,
    t.status === 'BLOCKED' ? (t.waitingFor ? (t.blockedReason ?? 'Waiting') : `Blocked on: ${t.blockedReason ?? 'not said'}`) : '',
    t.parentId ? `A part of: ${core.tasks.get(t.parentId)?.key ?? 'a task that is gone'}` : '',
    parts.length ? `Parts: ${parts.map((p) => `${p.key} [${p.status}] ${truncate(p.title, 60)}${p.assigneeId ? ` — ${core.employees.get(p.assigneeId)?.name}` : ''}`).join('; ')}` : '',
    t.helperIds?.length ? `On it with the assignee: ${t.helperIds.map((id) => core.employees.get(id)?.name).filter(Boolean).join(', ')}` : '',
    t.requiresReview ? `Reviewed by: ${{ both: 'a colleague, then the boss', boss: 'the boss', peer: 'a colleague', none: 'nobody' }[reviewByOf(t)]}${t.status === 'REVIEW' ? ` (now: ${t.reviewStage === 'boss' ? 'the boss' : 'a colleague'})` : ''}` : '',
    `Project: ${project?.name ?? 'unknown'}`,
    t.branch ? `Branch: ${t.branch}` : '',
    t.worktree ? `Worktree: ${t.worktree}` : '',
    '',
    t.description || '(no description)',
    t.acceptance ? `\nAcceptance criteria:\n${t.acceptance}` : '',
    deps.length ? `\nDependencies: ${deps.map((d) => `${d.key} [${d.status}] ${d.title}`).join('; ')}` : '',
    (t.verifyCommand ?? project?.verifyCommand) ? `\nVerified by: ${t.verifyCommand ?? project?.verifyCommand}` : '',
    t.evidence.review?.verdict === 'changes_requested' ? `\nReview feedback to address: ${t.evidence.review.comments}` : '',
    t.evidence.verification && t.evidence.verification.passed === false ? `\nLast verification failed:\n${truncate(t.evidence.verification.outputTail, 1500)}` : '',
    thread ? `\nThe conversation on it (newest last):\n${thread}` : '',
    t.attachments?.length
      ? `\nFiles on the task:\n${t.attachments.map((x) => `- ${x.name} (${x.kind === 'evidence' ? `evidence from ${x.addedBy.name}` : `attached by ${x.addedBy.name}`}${x.caption ? `: ${x.caption}` : ''})${x.kind === 'input' && Object.values(x.paths ?? {}).length ? ` — on the machine it was sent to: ${Object.values(x.paths!).join(', ')}` : ''}`).join('\n')}`
      : '',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

/**
 * The Orchestrator MCP server: the structured channel between real Claude Code
 * workers and the office. Every tool here changes real orchestration state.
 */
export function buildMcpServer(eng: Engine): McpServerOptions<McpContext> {
  const core = eng.core;
  const err = (text: string) => ({ text, isError: true });
  // The board tools: on unless the owner switched them off.
  const managing = () => core.settings.employeesManageBoard !== false;
  const OFF = err('The owner keeps the task board to themselves in this office (Settings → Employees). Ask the boss (ask_boss).');
  const by = (e: Employee) => `employee:${e.name}`;
  const personal = (hostId: string | null | undefined) => !!core.hosts.get(hostId ?? '')?.memberId;
  const sameSide = (a: Employee, b: Employee) => !(personal(a.hostId) || personal(b.hostId)) || a.hostId === b.hostId;
  /** A task this employee may know about (their own project's first when two share a key). One answer for "no such task" and "not yours to see". */
  /** Is `to` on a member's own computer whose room is closed to `from`? The words to refuse with, or null. */
  const closedTo = (from: Employee, to: Employee): string | null => {
    const member = eng.hosts.memberOfHost(to.hostId);
    if (!member || eng.hosts.memberOfHost(from.hostId) === member || !eng.hosts.isClosed(member)) return null;
    return `${to.name} works on a member's own computer, and that member has closed their room: nothing reaches them from outside until it is open again. Nothing was sent.`;
  };
  /**
   * How much one employee may put into the office in an hour, by kind. An employee whose session was steered (a page
   * it read, a file) is otherwise a way to fill the board, the Inbox and every colleague's queue without end.
   */
  const made = new Map<string, number[]>();
  const tooMany = (e: Employee, kind: string, perHour: number, add = 1): string | null => {
    const key = `${e.id}|${kind}`;
    const now = Date.now();
    const recent = (made.get(key) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length + add > perHour) return `That is more than ${perHour} in an hour (${kind}). Stop and work with what is there; if more is really needed, say so to the boss (ask_boss).`;
    for (let i = 0; i < add; i++) recent.push(now);
    made.set(key, recent);
    if (made.size > 5000) made.clear();
    return null;
  };
  const seen = (e: Employee, ref: unknown): Task | null => {
    const t = eng.tasks.taskByKey(String(ref ?? ''), e.projectId);
    return t && eng.tasks.canSee(e, t) ? t : null;
  };
  const noTask = (ref: unknown) => err(`No task "${ref}" that you can see. Use get_project_context to see the tasks of your project.`);
  const heldProject = (t: Task) => {
    const p = core.projects.get(t.projectId);
    return p && p.status !== 'active' ? err(`${p.name} is ${p.status}: the owner decides when work on it continues.`) : null;
  };
  const handlers: Record<string, McpToolHandler<McpContext>> = {
    get_current_task: async (_a, { employee }) => {
      const task = eng.tasks.currentTask(employee.id);
      const goal = eng.goals.describe(employee.id);
      if (!task) {
        const next = core.tasks.filter((t) => t.assigneeId === employee.id && (t.status === 'READY' || t.status === 'REVIEW' || t.status === 'BLOCKED'));
        if (goal) return `You have no task in progress${next.length ? ` (assigned to you: ${next.map((t) => `${t.key} [${t.status}] ${t.title}`).join('; ')})` : ''}.\n\n${goal}`;
        return next.length ? `You have no task in progress. Assigned to you: ${next.map((t) => `${t.key} [${t.status}] ${t.title}`).join('; ')}. Wait until one is handed to you.` : 'You have no task right now. Wait for one; do not invent work.';
      }
      return goal ? `${describeTask(eng, task)}\n\n${goal}` : describeTask(eng, task);
    },

    get_project_context: async (_a, { employee }) => {
      const project = core.projects.get(eng.tasks.currentTask(employee.id)?.projectId ?? employee.projectId);
      if (!project) return 'You are not assigned to a project.';
      const tasks = core.tasks.filter((t) => t.projectId === project.id && t.kind !== 'review');
      const team = core.employees.filter((e) => !e.archived && (e.projectId === project.id || !!e.alsoProjectIds?.includes(project.id)));
      return [
        `Project: ${project.name}`,
        project.description ? `Description: ${project.description}` : '',
        project.goals ? `Goals:\n${project.goals}` : '',
        project.requirements ? `Requirements:\n${project.requirements}` : '',
        project.docs ? `Documentation notes:\n${project.docs}` : '',
        `Base branch: ${project.baseBranch} · Integration branch: ${project.integrationBranch}`,
        project.extraRepos?.length ? `Other repositories of this project (available to you as additional directories):\n${project.extraRepos.map((x) => `- ${x.name}: ${x.path}`).join('\n')}` : '',
        project.dependsOn?.length ? `Builds on these projects:\n${project.dependsOn.map((d) => core.projects.get(d)).filter((d): d is NonNullable<typeof d> => !!d).map((d) => `- ${d.name}${d.deliveredAt ? ' (delivered)' : ` (${d.status}, not delivered yet)`}${d.repoPath ? ` — ${d.repoPath}` : ''}`).join('\n')}` : '',
        project.verifyCommand ? `Verification command: ${project.verifyCommand}` : 'No verification command is configured.',
        `Team: ${team.map((e) => `${e.name} (${e.title})`).join(', ') || 'none'}`,
        tasks.length ? `Tasks:\n${tasks.map((t) => `- ${t.key} [${t.status}] ${t.title}${t.assigneeId ? ` — ${core.employees.get(t.assigneeId)?.name}` : t.roleHint ? ` — unassigned (${t.roleHint})` : ''}`).join('\n')}` : 'No tasks yet.',
      ]
        .filter(Boolean)
        .join('\n\n');
    },

    report_status: async (a, { employee, session }) => {
      const status = truncate(String(a.status), 160);
      core.event({ type: 'agent.status_report', source: 'mcp', summary: `${employee.name}: ${status}`, employeeId: employee.id, sessionId: session.id, taskId: eng.tasks.currentTask(employee.id)?.id ?? null, projectId: employee.projectId, data: { status, detail: a.detail ? truncate(String(a.detail), 800) : null } });
      // Only the caption changes: the activity state itself stays whatever the hooks say.
      session.activityDetail = status;
      core.put('session', session);
      return 'Status recorded.';
    },

    report_progress: async (a, { employee }) => {
      const task = eng.tasks.progress(employee, String(a.note), typeof a.percent === 'number' ? a.percent : undefined);
      return task ? `Progress recorded on ${task.key}.` : { text: 'You have no task in progress, so there is nothing to report progress on.', isError: true };
    },

    ask_boss: async (a, { employee, session, signal }) => {
      // (The same question asked again is not a new one, and is not counted: see `sameQuestion` below.)
      if (!eng.comms.sameQuestion(employee.id, String(a.question), eng.tasks.currentTask(employee.id)?.id ?? null)) {
        const many = tooMany(employee, 'question to the boss', 30);
        if (many) return err(many);
      }
      const options = Array.isArray(a.options) ? a.options.filter((o: any) => o && typeof o.label === 'string').map((o: any) => ({ label: String(o.label), description: o.description ? String(o.description) : undefined, consequence: o.consequence ? String(o.consequence) : undefined, release: o.release === true })) : [];
      // The same question once more — the call that was waiting for the answer was cut off (the office restarted, a
      // connection dropped) and the employee asks again: it is the question the boss already has, not a second one.
      const asked = eng.comms.sameQuestion(employee.id, String(a.question), eng.tasks.currentTask(employee.id)?.id ?? null);
      if (asked?.status === 'answered') {
        eng.comms.cancelFor({ kind: 'question', id: asked.id });
        eng.comms.answerReturnedByTool(asked.id);
        return answerLine(asked);
      }
      // (A question is read by a person, in a window: it has a person's size.)
      const q = asked ?? eng.comms.createQuestion({ kind: a.kind ?? 'question', channel: 'mcp_tool', employee, session, text: truncate(String(a.question), 4000), context: a.context ? truncate(String(a.context), 8000) : '', why: a.why ? truncate(String(a.why), 2000) : '', options: options.slice(0, 12) });
      eng.sessions.setActivity(session, 'waiting_answer', truncate(q.text, 120));
      const answered = await eng.comms.waitForAnswer(q.id, core.timings.askBossWaitMs, signal);
      // ('delivered': another call of the same question — one that was cut off and is no longer listened to — was
      // woken first and marked it handed over. The answer is the answer.)
      if (answered && (answered.status === 'answered' || answered.status === 'delivered' || answered.status === 'confirmed')) {
        eng.comms.answerReturnedByTool(q.id);
        return answerLine(answered);
      }
      if (answered && answered.status === 'superseded') return { text: 'The question was withdrawn before it was answered. Use your best judgement on reversible details, or ask again if it still matters.', isError: true };
      return `The boss has not answered yet. Your question is recorded with id ${q.id} and is visible in the office. Do not guess the answer. Either continue with work that does not depend on it, or call wait_for_answer with question_id "${q.id}" to keep waiting. If the boss answers while you are working, the answer will be delivered to you.`;
    },

    wait_for_answer: async (a, { employee }) => {
      const q = core.questions.get(String(a.question_id)) ?? core.questions.find((x) => x.id.startsWith(String(a.question_id)));
      if (!q || q.employeeId !== employee.id) return { text: 'No such question of yours.', isError: true };
      if (q.status === 'delivered' || q.status === 'confirmed') return answerLine(q);
      const answered = q.status === 'answered' ? q : await eng.comms.waitForAnswer(q.id, core.timings.askBossWaitMs);
      if (answered && (answered.status === 'answered' || answered.status === 'delivered')) {
        // An answer may also be queued for terminal delivery; returning it here makes that redundant.
        eng.comms.cancelFor({ kind: 'question', id: q.id });
        eng.comms.answerReturnedByTool(q.id);
        return answerLine(answered);
      }
      return `Still no answer to question ${q.id}. Continue with other work or call wait_for_answer again.`;
    },

    report_blocker: async (a, { employee }) => {
      const often = tooMany(employee, 'blocker report', 20);
      if (often) return err(often);
      const task = eng.tasks.blockFromAgent(employee, String(a.reason), a.needs ? String(a.needs) : undefined);
      return task ? `${task.key} is marked BLOCKED and the boss has been alerted. Stop working on it and wait for instructions.` : 'The boss has been alerted that you are blocked.';
    },

    comment_on_task: async (a, { employee, session, signal }) => {
      const many = tooMany(employee, 'comment on a ticket', 120);
      if (many) return err(many);
      return eng.talk.byEmployee(employee, session, { task: a.task ? String(a.task) : undefined, text: String(a.text ?? ''), to: Array.isArray(a.to) ? a.to.map(String) : typeof a.to === 'string' ? [a.to] : undefined, ask: a.ask === true, options: Array.isArray(a.options) ? a.options : undefined, context: a.context ? String(a.context) : undefined, why: a.why ? String(a.why) : undefined, files: Array.isArray(a.files) ? a.files.map(String) : typeof a.files === 'string' ? [a.files] : undefined }, signal);
    },

    split_task: async (a, { employee }) => {
      const many = tooMany(employee, 'part of a ticket', 24, Array.isArray(a.parts) ? Math.max(1, a.parts.length) : 1);
      if (many) return err(many);
      return eng.talk.split(employee, a.parts);
    },

    complete_task: async (a, { employee }) => eng.tasks.completeFromAgent(employee, { summary: String(a.summary), tests_run: a.tests_run ? String(a.tests_run) : undefined, no_code_changes: a.no_code_changes === true, release_plan: typeof a.release_plan === 'string' ? a.release_plan : undefined }),
    report_released: async (a, { employee }) => eng.release.reported(employee, String(a.task ?? ''), String(a.note ?? '')),

    submit_result: async (a, { employee, session }) => {
      const task = eng.tasks.currentTask(employee.id);
      const art = eng.addArtifact({ kind: a.kind ?? 'report', title: truncate(String(a.title), 160), content: String(a.content), projectId: task?.projectId ?? employee.projectId, taskId: task?.id ?? null, employeeId: employee.id });
      core.event({ type: 'agent.result_submitted', source: 'mcp', summary: `${employee.name} submitted "${art.title}"`, employeeId: employee.id, sessionId: session.id, taskId: task?.id ?? null, projectId: art.projectId, data: { artifactId: art.id, kind: art.kind } });
      return `Stored as document ${art.id}. The boss can read it in the office.`;
    },

    request_review: async (a, { employee }) => {
      const task = eng.tasks.currentTask(employee.id);
      if (!task) return { text: 'You have no task in progress to review.', isError: true };
      task.requiresReview = true;
      // (A task that was not to be reviewed: by a colleague, as asked for here.)
      if (!task.reviewBy || task.reviewBy === 'none') task.reviewBy = 'peer';
      if (a.reviewer) {
        const r = eng.comms.resolveTeammate(employee, String(a.reviewer));
        if (r && !eng.tasks.canSee(r, task)) return err(`${r.name} cannot review ${task.key}: work does not cross between the shared office and a member's own computer.`);
        if (r && r.id !== employee.id) task.reviewerId = r.id;
      }
      core.put('task', task);
      // Code reviewers come first: a colleague named who is not one is not asked while a code reviewer can take it.
      const named = task.reviewerId ? core.employees.get(task.reviewerId) : undefined;
      const code = named && eng.tasks.isCodeReviewer(named, task) ? undefined : eng.tasks.codeReviewerFor(task);
      if (code) return `${task.key} will go to review by ${code.name}, the code reviewer, once you call complete_task and it passes verification${named ? ` (code reviewers come first: ${named.name} is not asked)` : ''}.${a.notes ? ' Put your notes for the reviewer in the complete_task summary.' : ''}`;
      return `${task.key} will go to review${task.reviewerId ? ` by ${core.employees.get(task.reviewerId)?.name}` : ''} once you call complete_task and it passes verification.${a.notes ? ' Put your notes for the reviewer in the complete_task summary.' : ''}`;
    },

    answer_team_question: async (a, { employee }) => {
      const answers = a.answers && typeof a.answers === 'object' && !Array.isArray(a.answers) ? (Object.fromEntries(Object.entries(a.answers as Record<string, unknown>).map(([k, v]) => [k, String(v)])) as Record<string, string>) : null;
      const q = await eng.comms.answerAsManager(employee, String(a.question_id ?? ''), { answer: String(a.answer ?? ''), answers });
      return `Answered ${core.employees.get(q.employeeId)?.name ?? 'the colleague'}'s question, in the boss's place. It is on the record as answered by you.`;
    },
    escalate_question: async (a, { employee }) => {
      eng.comms.escalateQuestion(employee, String(a.question_id ?? ''), String(a.why ?? ''));
      return "It is the boss's to answer now; they are told why.";
    },

    escalate_review: async (a, { employee }) => {
      const task = eng.tasks.escalateReview(employee, String(a.task ?? ''), String(a.why ?? ''));
      return `${task.key} is the boss's to decide now; they are told why.`;
    },

    submit_review: async (a, { employee }) => {
      // A verdict that comes after the task went on without it (a colleague was quicker) is kept as a second opinion.
      const late = eng.tasks.secondOpinion(employee, String(a.task), a.verdict, String(a.comments ?? ''));
      if (late) return late;
      const task = await eng.tasks.submitReview(employee, String(a.task), a.verdict, String(a.comments), undefined, { checked: typeof a.checked === 'string' ? a.checked : null });
      return a.verdict === 'approve' ? `Approved. ${task.key} is now ${task.status}.` : `Changes requested. ${task.key} goes back to ${core.employees.get(task.assigneeId)?.name ?? 'its author'} with your comments.`;
    },

    message_person: async (a, { employee }) => {
      const text = String(a.message ?? '').trim();
      if (!text) return err('Write the message in "message".');
      const plain = (x: string) => x.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const want = plain(String(a.to ?? '')).replace(/^@/, '');
      const people = eng.comms.people();
      // On a member's own computer what is said stays with that member: they are the only one to write to.
      const member = eng.hosts.memberOfHost(employee.hostId);
      let to: { for: string[]; name: string } | null = null;
      if (member) {
        const them = people.find((p) => p.id === member);
        if (!them) return err('The member whose computer you work on is not in the office now. Nothing was sent.');
        if (['boss', 'the boss', 'owner', 'owners', plain(them.name), plain(them.name).split(' ')[0]].includes(want)) to = { for: [them.id], name: them.name };
        else return err(`You work on ${them.name}'s own computer: what you write goes to ${them.name} only. Write to "${them.name}". Nothing was sent.`);
      } else if (['boss', 'the boss', 'owner', 'owners'].includes(want)) {
        to = { for: [FOR_OWNERS], name: 'the boss' };
      } else {
        const exact = people.filter((p) => plain(p.name) === want);
        const first = exact.length ? exact : people.filter((p) => plain(p.name).split(' ')[0] === want);
        if (first.length === 1) to = { for: [first[0]!.id], name: first[0]!.name };
        else {
          const names = ['the boss', ...people.filter((p) => p.id !== 'owner').map((p) => p.name)];
          return err(`${first.length > 1 ? `More than one person is called "${a.to}"; write the whole name.` : `Nobody in the office is called "${a.to}" (an employee? use send_message).`} You can write to: ${names.join(', ')}. Nothing was sent.`);
        }
      }
      const many = tooMany(employee, 'message to a person', 20);
      if (many) return err(many);
      const urgent = a.urgent === true;
      const task = eng.tasks.currentTask(employee.id);
      const firstLine = text.split('\n').find((l) => l.trim())!.trim();
      const note = eng.comms.notify({
        kind: 'message',
        severity: urgent ? 'warning' : 'info',
        title: `${employee.name}${urgent ? ' · urgent' : ''}: ${truncate(firstLine, 110)}`,
        body: truncate(text, 4000),
        employeeId: employee.id,
        taskId: task?.id ?? null,
        projectId: employee.projectId,
        for: to.for,
      });
      core.event({ type: 'agent.message_to_person', source: 'mcp', summary: `${employee.name} wrote to ${to.name}`, employeeId: employee.id, taskId: task?.id ?? null, projectId: employee.projectId, data: { to: to.name, notificationId: note.id, urgent } });
      return `Sent to ${to.name}: it is in their Inbox${urgent ? ', marked urgent' : ''}, and on Telegram if they talk to you there. If they answer, it comes to you as a message — carry on meanwhile.`;
    },

    message_client: async (a, { employee }) => {
      const many = tooMany(employee, 'message to a client', 20);
      if (many) return err(many);
      try {
        const { client } = eng.rent.write(employee, a.to, a.message);
        return `Sent to ${client.name}: it is in your conversation with them on the Rent portal now, marked new. When they answer, it comes to you as their message — carry on meanwhile.`;
      } catch (e) {
        return err((e as Error).message);
      }
    },

    send_message: async (a, { employee }) => {
      const to = eng.comms.resolveTeammate(employee, String(a.to));
      if (!to) return { text: `No teammate matches "${a.to}". Use get_team.`, isError: true };
      const shut = closedTo(employee, to);
      if (shut) return err(shut);
      const many = tooMany(employee, 'message', 120);
      if (many) return err(many);
      eng.comms.sendMessage({ from: { kind: 'employee', id: employee.id, name: `${employee.name} (${employee.title})` }, toEmployeeId: to.id, body: String(a.message), taskId: eng.tasks.currentTask(employee.id)?.id ?? null });
      return `Message queued for ${to.name}. It is delivered to their session when they can read it.`;
    },

    hand_off_task: async (a, { employee }) => eng.tasks.handOff(employee, String(a.to), String(a.notes ?? '')),

    request_collaboration: async (a, { employee, session, signal }) => {
      const wait = a.wait === true;
      const target = eng.comms.resolveTeammate(employee, String(a.to));
      // Refused before anything is sent: a request that says "I am waiting" must be one that can be waited for.
      const no = wait && target ? eng.waits.cannotWaitFor(employee, session, target, 'answer') : null;
      if (no) return { text: `${no} Nothing was sent. If they only need to know, send it without wait.`, isError: true };
      const shut = target ? closedTo(employee, target) : null;
      if (shut) return err(shut);
      const many = tooMany(employee, 'request', 60);
      if (many) return err(many);
      const collab = eng.comms.requestCollaboration(employee, target ?? String(a.to), String(a.summary), a.detail ? String(a.detail) : '', { waited: wait });
      if (wait) return eng.waits.forRequest(employee, session, collab, signal);
      const to = core.employees.get(collab.toEmployeeId);
      return `Request ${collab.id} sent to ${to?.name} (${to?.title}). They will respond; the response is delivered to you. Continue with what you can in the meantime.`;
    },

    wait_for_colleague: async (a, { employee, session, signal }) => {
      const request = a.request_id ? String(a.request_id).trim() : '';
      const task = a.task ? String(a.task).trim() : '';
      if (request && task) return { text: 'Pass request_id or task, not both: one wait at a time.', isError: true };
      if (task) return eng.waits.forTask(employee, session, task, signal);
      if (!request) return eng.waits.resume(employee, session, signal);
      const collab = eng.waits.findRequest(employee, request);
      return collab ? eng.waits.forRequest(employee, session, collab, signal) : { text: `No request "${request}" of yours. It is the id you were given when you sent it.`, isError: true };
    },

    request_help: async (a, { employee, session, signal }) => {
      const many = tooMany(employee, 'request', 60);
      if (many) return err(many);
      const task = eng.tasks.currentTask(employee.id);
      const roleOrder = ['architect', 'fullstack', 'backend', 'frontend', 'qa', 'security', 'devops'];
      const helper = core.employees
        .filter((e) => !e.archived && e.id !== employee.id && !!core.runningSessionOf(e.id) && (e.projectId === employee.projectId || !e.projectId) && sameSide(employee, e) && !closedTo(employee, e) && eng.rent.reaches(employee, e))
        .sort((x, y) => roleOrder.indexOf(x.roleKey) - roleOrder.indexOf(y.roleKey))
        .find((e) => roleOrder.includes(e.roleKey));
      if (helper) {
        const wait = a.wait === true;
        const no = wait ? eng.waits.cannotWaitFor(employee, session, helper, 'answer') : null;
        if (no) return { text: `${no} Nothing was sent. Ask without wait, or ask the boss (ask_boss).`, isError: true };
        const collab = eng.comms.requestCollaboration(employee, helper, `Help needed: ${String(a.topic)}`, a.detail ? String(a.detail) : '', { waited: wait });
        if (wait) return eng.waits.forRequest(employee, session, collab, signal);
        return `Help request ${collab.id} sent to ${helper.name} (${helper.title}).`;
      }
      const q = eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee, session, text: `${employee.name} needs help: ${String(a.topic)}`, context: a.detail ? String(a.detail) : '', why: task ? `They are working on ${task.key}.` : '' });
      return `No teammate is available to help, so the boss was asked (question id ${q.id}). Call wait_for_answer to wait for a reply.`;
    },

    respond_to_request: async (a, { employee }) => {
      const { collab, unblocked } = eng.comms.respondToRequest(employee, String(a.request_id), a.action, String(a.note));
      const asker = core.employees.get(collab.fromEmployeeId)?.name ?? 'your colleague';
      // Who this let go on: someone held a tool call open for it, or said they would wait and is told by a message.
      if (unblocked) return `Response recorded (${collab.status}). ${asker} was waiting for it and has it now: they can go on.`;
      return `Response recorded (${collab.status}) and sent to ${asker}${collab.waited ? ', who is waiting for it' : ''}.`;
    },

    check_messages: async (_a, { employee }) => {
      const msgs = eng.comms.pullMessages(employee.id);
      if (!msgs.length) return 'No new messages.';
      return msgs.map((m) => `From ${m.from.name}${m.threadId ? ` (request id ${m.threadId})` : ''}: ${m.body}`).join('\n\n');
    },

    set_goal: async (a, { employee }) => {
      const often = tooMany(employee, 'goal', 20);
      if (often) return err(often);
      try {
        const g = eng.goals.set(employee.id, { condition: a.condition }, { kind: 'employee', id: employee.id, name: employee.name });
        return `Goal set: ${g.condition}\n\nWork toward it now. Each time your turn ends while it does not hold, the office sends you on. When it holds, call goal_met with how you know. (It stops by itself after ${GOAL_IDLE_TURNS} turns in a row without anything done.)`;
      } catch (e) {
        return err((e as Error).message);
      }
    },

    goal_met: async (a, { employee, session }) => eng.goals.met(employee, session, a.evidence),

    set_model: async (a, { employee }) => {
      if (core.settings.employeesSetModels === false) return err('The owner keeps models and effort to themselves in this office (Settings → Employees). Ask the boss (ask_boss) if a change is needed.');
      const often = tooMany(employee, 'model change', 30);
      if (often) return err(often);
      const name = String(a.employee ?? '').trim();
      const to = name ? eng.comms.resolveTeammate(employee, name) : employee;
      if (!to || to.archived) return err(`No teammate matches "${name}". Use get_team.`);
      const self = to.id === employee.id;
      if (to.executionMode === 'codex_managed') return err(`${to.name} uses the Codex runtime’s default model and effort.`);
      if (!self && to.roleKey === LEAD_ROLE) return err(`${to.name} is a member's team lead: what it thinks with is that member's to set.`);
      if (!sameSide(employee, to)) return err(`${to.name} works on ${personal(to.hostId) ? "a member's own computer" : 'the shared office'} and you do not: their settings are not yours to change.`);
      const closed = closedTo(employee, to);
      if (closed) return err(closed);
      const reason = String(a.reason ?? '').trim();
      if (reason.length < 8) return err('Say in "reason" why — what the work needs. It is on the record, and they read it.');
      const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
      const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
      const patch: { model?: string | null; effort?: string | null } = {};
      if (a.model !== undefined && String(a.model).trim()) {
        const m = String(a.model).trim().toLowerCase();
        if (m !== 'default' && !MODELS.includes(m)) return err(`"${a.model}" is not a model to choose: ${MODELS.join(', ')}, or default.`);
        patch.model = m === 'default' ? null : m;
      }
      if (a.effort !== undefined && String(a.effort).trim()) {
        const x = String(a.effort).trim().toLowerCase();
        if (x !== 'default' && !EFFORTS.includes(x)) return err(`"${a.effort}" is not an effort: ${EFFORTS.join(', ')}, or default.`);
        patch.effort = x === 'default' ? null : x;
      }
      if (!('model' in patch) && !('effort' in patch)) return err('Say the model, the effort, or both.');
      const changes = Object.fromEntries(Object.entries(patch).filter(([k, v]) => (to as any)[k] !== v));
      if (!Object.keys(changes).length) return `${self ? 'You are' : `${to.name} is`} already on that.`;
      const words = (m: string | null | undefined, x: string | null | undefined) => `${m ? m.charAt(0).toUpperCase() + m.slice(1) : "the account's default model"}, ${x ? `${x} effort` : 'the default effort'}`;
      const before = words(to.model, to.effort);
      const after = eng.employees.update(to.id, changes, by(employee));
      const now = words(after.model, after.effort);
      core.audit(by(employee), 'employee.model_set', to.id, { employee: to.name, before, after: now, reason: truncate(reason, 400) });
      core.event({ type: 'employee.updated', source: 'mcp', summary: `${employee.name} put ${self ? 'themselves' : to.name} on ${now}: ${truncate(reason, 160)}`, employeeId: to.id, data: { by: employee.name, model: after.model, effort: after.effort, reason: truncate(reason, 400) } });
      if (!self) eng.comms.sendMessage({ from: { kind: 'employee', id: employee.id, name: `${employee.name} (${employee.title})` }, toEmployeeId: to.id, body: `I put you on ${now} (it was ${before}): ${truncate(reason, 600)}`, taskId: eng.tasks.currentTask(to.id)?.id ?? null });
      const live = core.runningSessionOf(to.id);
      return `${self ? 'You are' : `${to.name} is`} on ${now} now (was ${before}).${live ? ` ${self ? 'Your' : 'Their'} session is started again with the same conversation ${self ? 'when this turn ends' : live.inTurn ? 'when their turn ends' : 'now'}.` : ` It applies when ${self ? 'your' : 'their'} next session starts.`}`;
    },

    get_team: async (_a, { employee }) => {
      const team = core.employees.filter((e) => !e.archived && e.id !== employee.id && eng.rent.reaches(employee, e));
      if (!team.length) return 'You are the only employee.';
      // What part of the office each one keeps: their project and folder say more than a title everyone shares. And
      // whether work can be given to them at all — it cannot cross to or from a member's own computer (a message can).
      const where = (e: Employee): string => {
        const project = core.projects.get(e.projectId);
        const folder = e.workingDir ? e.workingDir.split('/').filter(Boolean).pop() : null;
        const own = e.projectId === employee.projectId ? '' : project ? ` · project ${project.name}` : ' · no project';
        const keeps = folder && folder.toLowerCase() !== project?.name.toLowerCase() ? ` · folder ${folder}` : '';
        const far = sameSide(employee, e) ? '' : " · on a member's own computer (send_message only; no tasks or waiting across)";
        return `${own}${keeps}${far}`;
      };
      return team
        .map((e) => {
          const s = core.runningSessionOf(e.id);
          const t = eng.tasks.currentTask(e.id);
          // What their finished work here shows (counted, not declared): whom to ask about what.
          const record = eng.improver.capture.skillsLine(e);
          const waiting = s?.waitingOn ? ` · waiting for ${eng.waits.words(s.waitingOn)}` : '';
          // What they think with (set_model changes it): their own setting, and what their session really runs when that differs.
          const thinks = `${e.model ?? 'default model'}${e.effort ? `, ${e.effort} effort` : ''}${s?.model && e.model && s.model !== e.model ? ` (now running ${s.model})` : ''}`;
          return `- ${e.name} — ${e.title}${where(e)} · ${s ? (ACTIVITY_LABEL[s.activity] ?? s.activity) : 'OFFLINE'}${waiting}${t ? ` · working on ${t.key} "${truncate(t.title, 50)}"` : ''}${record ? ` · ${record}` : ''} · thinks with ${thinks}`;
        })
        .join('\n');
    },

    get_available_tasks: async (_a, { employee }) => {
      const tasks = core.tasks.filter((t) => t.projectId === employee.projectId && t.status === 'READY' && !t.assigneeId);
      return tasks.length ? tasks.map((t) => `- ${t.key} [${t.priority}] ${t.title}${t.roleHint ? ` (role: ${t.roleHint})` : ''}`).join('\n') : 'No unassigned ready tasks in your project.';
    },

    claim_task: async (a, { employee }) => {
      // (Only a task they may see: one on a member's own computer is not there for somebody of the shared office —
      // not to take, and not to learn from the answer that it exists.)
      const task = seen(employee, a.task);
      if (!task) return { text: `No task ${a.task}.`, isError: true };
      const project = core.projects.get(task.projectId);
      if (!project?.policy.autoAssign) return { text: 'This project does not allow self-assignment; ask the boss.', isError: true };
      if (task.status !== 'READY' || task.assigneeId) return { text: `${task.key} is not an unassigned ready task.`, isError: true };
      if (eng.tasks.currentTask(employee.id)) return { text: 'Finish your current task first.', isError: true };
      eng.tasks.updateTask(task.id, { assigneeId: employee.id }, `employee:${employee.name}`);
      return `${task.key} is yours. It will be handed to you as soon as your current turn ends.`;
    },

    propose_tasks: async (a, { employee }) => {
      const projectId = eng.tasks.currentTask(employee.id)?.projectId ?? employee.projectId;
      if (!projectId) return { text: 'You are not assigned to a project.', isError: true };
      const count = Array.isArray(a.tasks) ? a.tasks.length : 0;
      const many = tooMany(employee, 'proposed task', 60, Math.max(1, count));
      if (many) return err(many);
      // Where the owner keeps the board, a proposal names nobody: who does what is the owner's to say.
      if (core.settings.employeesManageBoard === false && Array.isArray(a.tasks)) a = { ...a, tasks: a.tasks.map((t: any) => (t && typeof t === 'object' ? { ...t, assignee: undefined } : t)) };
      const { created, existing } = eng.tasks.propose(employee, projectId, a.tasks, a.rationale ? String(a.rationale) : undefined, 'planning');
      // Items a repeating check has already reported: nothing is added, and the employee is told so.
      const already = existing.length ? `Already on the board, so not added again: ${existing.map((t) => `${t.key} [${t.status}]`).join(', ')}.` : '';
      if (!created.length) return `Nothing new was added. ${already}`;
      const waiting = created.filter((t) => !t.released);
      const fate = !waiting.length ? 'They are scheduled automatically as dependencies complete.' : waiting.length === created.length ? 'They wait in the backlog for the boss to release them.' : `${waiting.map((t) => t.key).join(', ')} wait in the backlog for the boss to release them; the rest are scheduled automatically.`;
      return `Created ${created.length} tasks: ${created.map((t) => t.key).join(', ')}. ${fate}${already ? ` ${already}` : ''}`;
    },

    record_lesson: async (a, { employee }) => {
      const over = tooMany(employee, 'lessons', 40);
      if (over) return err(over);
      return eng.improver.recordFromAgent(employee, { lesson: a.lesson ? String(a.lesson) : undefined, applies_when: a.applies_when ? String(a.applies_when) : undefined, why: a.why ? String(a.why) : undefined, scope: a.scope, none: a.none === true, reason: a.reason ? String(a.reason) : undefined, replaces: a.replaces ? String(a.replaces) : undefined });
    },

    get_playbook: async (_a, { employee }) => {
      const projectId = eng.tasks.currentTask(employee.id)?.projectId ?? employee.projectId;
      return eng.improver.playbookBlock(employee, projectId, false) || 'Your playbook is empty so far. Record lessons with record_lesson as you learn them.';
    },

    meeting_contribute: async (a, { employee }) => eng.meetings.contribute(employee, String(a.meeting_id), String(a.body), Array.isArray(a.disagreements) ? a.disagreements.map(String) : []),

    meeting_conclude: async (a, { employee }) => {
      const text = eng.meetings.conclude(employee, String(a.meeting_id), String(a.decision_doc), Array.isArray(a.tasks) ? a.tasks : []);
      // Lessons a team agrees on in a meeting are proposed as shared knowledge.
      let recorded = 0;
      for (const lesson of Array.isArray(a.lessons) ? a.lessons.slice(0, 5) : []) {
        try {
          eng.improver.recordFromAgent(employee, { lesson: String(lesson), applies_when: `agreed in meeting ${a.meeting_id}`, why: `The team agreed on this in meeting ${a.meeting_id}`, scope: 'project' });
          recorded++;
        } catch {
          /* skip malformed entries */
        }
      }
      return recorded ? `${text} ${recorded} team lesson${recorded === 1 ? '' : 's'} recorded.` : text;
    },

    // ── The board in the employees' hands (the office setting "Employees manage the task board themselves") ──

    get_task: async (a, { employee }) => {
      const task = seen(employee, a.task);
      return task ? describeTask(eng, task) : noTask(a.task);
    },

    attach_file: async (a, { employee }) => {
      const task = a.task ? seen(employee, a.task) : eng.tasks.currentTask(employee.id);
      const file = String(a.path ?? '').trim();
      if (!file) return err('Give the path of the file on this machine.');
      const caption = a.caption ? truncate(String(a.caption).trim(), 300) : null;
      const size = (n: number) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
      if (!task) {
        if (a.task) return noTask(a.task);
        // Not on a task: the file is for the boss, in the conversation with them.
        const many = tooMany(employee, 'file given to the boss', 60);
        if (many) return err(many);
        try {
          const given = await eng.saidFiles.give(employee, file, (e, p, dest) => eng.attachments.pull(e, p, dest));
          // While answering a client on the Rent portal, the file is for that client's conversation (rent.ts).
          const clientId = eng.rent.clientOfTurn(employee.id);
          const client = eng.rent.active(clientId);
          if (client) {
            core.event({ type: 'agent.file_given', source: 'mcp', summary: `${employee.name} gave ${client.name} a file: ${given.name}`, employeeId: employee.id, projectId: employee.projectId, data: { file: given, caption, rentClientId: client.id, quiet: true } });
            return `${given.name} (${size(given.size)}) is in your conversation with ${client.name} on the portal${caption ? `: ${caption}` : ''}. Say in your reply what it is.`;
          }
          core.event({ type: 'agent.file_given', source: 'mcp', summary: `${employee.name} gave the boss a file: ${given.name}`, employeeId: employee.id, projectId: employee.projectId, data: { file: given, caption } });
          eng.comms.noteGivenFile(employee, given.name, caption);
          return `${given.name} (${size(given.size)}) is in your conversation with the boss${/^image\//.test(given.mime) ? ', where they see it' : ', where they can download it'}${caption ? `: ${caption}` : ''}. Say in your reply what it is.`;
        } catch (e) {
          return err((e as Error).message);
        }
      }
      if (task.assigneeId !== employee.id && !core.tasks.find((t) => t.reviewOf === task.id && t.assigneeId === employee.id)) return err(`${task.key} is not your task. Evidence is left by whoever does or reviews the work.`);
      try {
        const att = await eng.attachments.attachFrom(task, employee, file, caption);
        // (Shown in the conversation with the boss as well: whoever asked "show me" there sees it there.)
        core.event({ type: 'agent.file_given', source: 'mcp', summary: `${employee.name} left ${att.name} on ${task.key}`, employeeId: employee.id, taskId: task.id, projectId: task.projectId, data: { file: { id: att.id, name: att.name, mime: att.mime, size: att.size }, caption: att.caption, taskId: task.id, quiet: true } });
        return `${att.name} (${att.size < 1024 ? `${att.size} bytes` : att.size < 1024 * 1024 ? `${Math.round(att.size / 1024)} KB` : `${(att.size / 1024 / 1024).toFixed(1)} MB`}) is on ${task.key} as evidence${att.caption ? `: ${att.caption}` : ''}. The boss and reviewers can open it in the office.`;
      } catch (e) {
        return err((e as Error).message);
      }
    },

    release_task: async (a, { employee }) => {
      if (!managing()) return OFF;
      const task = seen(employee, a.task);
      if (!task) return noTask(a.task);
      const held = heldProject(task);
      if (held) return held;
      if (task.released) return `${task.key} is already released (${task.status}).`;
      if (task.status !== 'BACKLOG') return err(`${task.key} is ${task.status}, not waiting in the backlog.`);
      eng.tasks.release([task.id], by(employee));
      core.event({ type: 'task.updated', source: 'mcp', summary: `${employee.name} released ${task.key} for scheduling`, taskId: task.id, projectId: task.projectId, employeeId: employee.id, data: { key: task.key, released: true, by: employee.id } });
      const open = eng.tasks.openDependencies(task);
      return `${task.key} "${truncate(task.title, 80)}" is released. ${open.length ? `It starts once ${open.map((d) => d.key).join(', ')} ${open.length === 1 ? 'is' : 'are'} done.` : task.assigneeId ? `It is handed to ${core.employees.get(task.assigneeId)?.name ?? 'its assignee'} as soon as they are free.` : 'It is given to someone suitable who is free (or give it to someone with give_task).'}`;
    },

    unblock_task: async (a, { employee }) => {
      if (!managing()) return OFF;
      const task = seen(employee, a.task);
      if (!task) return noTask(a.task);
      const held = heldProject(task);
      if (held) return held;
      if (task.status !== 'BLOCKED') return err(`${task.key} is not blocked (${task.status}).`);
      if (task.waitingFor?.kind === 'parts') return err(`${task.key} is not blocked: it waits for its parts and goes on by itself when they are done.`);
      if (task.blockedReason === 'Blocked by the owner') return err(`The boss blocked ${task.key}. It stays blocked until the boss says otherwise (ask_boss if it matters now).`);
      const note = String(a.note ?? '').trim();
      if (note.length < 12) return err('Say in "note" how the blocker is resolved — what was found, decided or fixed. Whoever picks the task up reads that.');
      const done = eng.tasks.unblock(task.id, truncate(note, 2000), by(employee), employee);
      return `${task.key} is unblocked: ${done.status === 'IN_PROGRESS' ? `${core.employees.get(done.assigneeId)?.name ?? 'its assignee'} was told and continues it` : 'it is back in the queue with your note and is handed out as soon as someone is free'}.`;
    },

    cancel_task: async (a, { employee }) => {
      if (!managing()) return OFF;
      const task = seen(employee, a.task);
      if (!task) return noTask(a.task);
      const held = heldProject(task);
      if (held) return held;
      if (task.status === 'DONE') return `${task.key} is already closed (DONE).`;
      if (task.personId) return err(`${task.key} is a person's task (${task.personName ?? 'theirs'}): it is theirs to close. Tell the boss if it is no longer wanted.`);
      if (task.status === 'REVIEW') return err(`${task.key} is in review. Its review decides what happens next.`);
      if (task.blockedReason === 'Blocked by the owner') return err(`The boss blocked ${task.key}. It is the boss's to decide (ask_boss if it matters now).`);
      if (task.status === 'IN_PROGRESS' && task.assigneeId !== employee.id) return err(`${core.employees.get(task.assigneeId)?.name ?? 'Somebody'} is in the middle of ${task.key}. Tell them (send_message) or the boss; it is not yours to stop.`);
      if (eng.tasks.isVerifying(task.id)) return err(`${task.key} is being checked right now. Let that finish first.`);
      const reason = String(a.reason ?? '').trim();
      if (reason.length < 12) return err('Say in "reason" why the task is no longer wanted — a duplicate of what, overtaken by what, not worth it because of what. The boss reads this.');
      eng.tasks.cancel(task.id, truncate(reason, 2000), by(employee), employee.name);
      return `${task.key} "${truncate(task.title, 80)}" is cancelled: closed, not deleted. The boss is told and can reopen it.`;
    },

    give_task: async (a, { employee }) => {
      if (!managing()) return OFF;
      const task = seen(employee, a.task);
      if (!task) return noTask(a.task);
      const held = heldProject(task);
      if (held) return held;
      const name = String(a.employee ?? '').trim();
      const to = name.toLowerCase() === employee.name.toLowerCase() ? employee : eng.comms.resolveTeammate(employee, name);
      if (!to || to.archived) return err(`No teammate matches "${name}". Use get_team.`);
      if (!eng.tasks.canSee(to, task)) return err(`${to.name} cannot take ${task.key}: work does not cross between the shared office and a member's own computer.`);
      // Work that is in review is decided by its review: given to somebody else now, its author would no longer be
      // "the assignee" and could approve it themselves.
      if (task.status === 'REVIEW') return err(`${task.key} is in review. Its review decides what happens next (submit_review, by somebody who did not do the work).`);
      if (task.assigneeId === to.id) return `${task.key} is already ${to.id === employee.id ? 'yours' : `assigned to ${to.name}`}.`;
      // Someone from another project is lent to this one, and keeps their own.
      const cannot = eng.tasks.lend(to, task.projectId);
      if (cannot) return err(cannot);
      if (task.status === 'IN_PROGRESS') return err(`${core.employees.get(task.assigneeId)?.name ?? 'Someone'} is in the middle of ${task.key}. Talk to them (send_message); they can hand it over themselves.`);
      if (task.status === 'DONE') return err(`${task.key} is done.`);
      eng.tasks.updateTask(task.id, { assigneeId: to.id }, by(employee));
      const next = task.status === 'READY' ? `It is handed to ${to.id === employee.id ? 'you' : 'them'} as soon as ${to.id === employee.id ? 'your turn ends' : 'they are free'}.` : task.status === 'BACKLOG' ? (task.released ? 'It starts once its dependencies are done.' : 'It is not released yet (release_task).') : `It is ${task.status}.`;
      return `${task.key} "${truncate(task.title, 80)}" is now ${to.id === employee.id ? 'yours' : `assigned to ${to.name}`}. ${next}`;
    },

    wake_colleague: async (a, { employee }) => {
      const often = tooMany(employee, 'wake-up', 20);
      if (often) return err(often);
      if (!managing()) return OFF;
      const to = eng.comms.resolveTeammate(employee, String(a.employee ?? ''));
      if (!to || to.archived) return err(`No teammate matches "${a.employee}". Use get_team.`);
      const reason = String(a.reason ?? '').trim();
      if (reason.length < 8) return err('Say in "reason" what they are needed for: it is the first thing they read.');
      if (!sameSide(employee, to)) return err(`${to.name} works on ${personal(to.hostId) ? "a member's own computer" : 'the shared office'} and you do not. Work does not cross between the two.`);
      const running = core.runningSessionOf(to.id);
      if (running && core.gateway.isPaused(running.id)) return err(`${to.name} is paused by the owner and stays so until the owner resumes them.`);
      const message = { from: { kind: 'employee' as const, id: employee.id, name: `${employee.name} (${employee.title})` }, toEmployeeId: to.id, body: truncate(reason, 2000), taskId: eng.tasks.currentTask(employee.id)?.id ?? null };
      if (running) {
        eng.comms.sendMessage(message);
        return `${to.name} is at their desk already (${(ACTIVITY_LABEL[running.activity] ?? running.activity).toLowerCase()}). Your message is delivered when they can read it.`;
      }
      const no = eng.sessions.cannotStart(to);
      if (no) return err(`${to.name} cannot be started right now: ${no}.`);
      const s = await eng.sessions.wake(to.id, `${employee.name}: ${truncate(reason, 120)}`);
      eng.comms.sendMessage(message);
      return `${to.name} is ${s.resumed ? 'awake again and continues where they left off' : 'started'}. Your message is the first thing they read.`;
    },

    // ── The vault ──

    vault_list: async (a, _ctx) => {
      const entries = eng.vault.list(String(a.query ?? ''));
      if (!entries.length) return a.query ? `Nothing in the vault matches "${a.query}".` : 'The vault is empty.';
      return [
        `${entries.length} in the vault. Use one in a command as $("$ORCH_VAULT" get NAME); the value is never shown.`,
        ...entries.map((e) => `- ${e.name} (${e.kind.replace('_', ' ')})${e.service ? ` · ${e.service}` : ''}${e.username ? ` · login ${e.username}` : ''}${e.description ? ` — ${e.description}` : ''}`),
      ].join('\n');
    },

    vault_store: async (a, { employee }) => {
      const value = String(a.value ?? '');
      if (/^\{\{vault:[^}]+\}\}$/.test(value.trim())) return err('That is the name of something already in the vault, not a value. Nothing to store.');
      const { entry, created } = eng.vault.put({ name: String(a.name ?? ''), value, kind: a.kind, service: a.service ? String(a.service) : '', username: a.username ? String(a.username) : '', description: a.description ? String(a.description) : '' }, { kind: 'employee', id: employee.id, name: employee.name }, 'stored');
      return created
        ? `Stored as "${entry.name}". From now on write {{vault:${entry.name}}} when you mention it, and $("$ORCH_VAULT" get ${entry.name}) where a command needs it. Do not repeat the value anywhere.`
        : `That value is already in the vault as "${entry.name}". Use that name.`;
    },

    // The helper's call: the value goes to the command that asked, and the use is on the record.
    vault_read: async (a, { employee }) => eng.vault.use(String(a.name ?? ''), { kind: 'employee', id: employee.id, name: employee.name }).value,

    // ── The central context (context.ts) ──

    get_context: async (a, { employee }) => eng.context.find(employee, String(a.topic ?? '').trim()),

    propose_context: async (a, { employee }) => {
      const many = tooMany(employee, 'context proposal', 30);
      if (many) return err(many);
      try {
        const fact = eng.context.propose(employee, a, eng.rent.clientOfTurn(employee.id));
        return fact.status === 'active' ? `In the central context now (${fact.layer}): "${fact.title}". Everyone concerned holds it from their next prompt.` : `Proposed: "${fact.title}". A person looks at it in the Context window; you are told nothing more — it simply appears in the context once taken in.`;
      } catch (e) {
        return err((e as Error).message);
      }
    },

    // ── The long memory ──

    recall: async (a) => {
      if (!eng.memory.available()) return err('This office has no long memory (MemPalace is not installed on its machine, or the owner switched it off).');
      const query = String(a.query ?? '').trim();
      if (query.length < 3) return err('Ask a question, or give a few words to look for.');
      const hits = await eng.memory.recall(query, { results: 6, timeoutMs: 45_000 });
      const close = hits.filter((h) => h.score >= RELEVANT);
      if (!close.length) return hits.length ? `Nothing in the office's memory is close to that. The nearest thing is about something else: "${truncate(hits[0]!.text.split('\n')[0] ?? '', 120)}".` : "The office's memory has nothing on that (or it did not answer in time).";
      return [`From the office's memory, closest first. These are records of what happened and was said; they may be out of date.`, ...close.map((h, i) => `${i + 1}. (${h.room}, match ${h.score.toFixed(2)})\n${truncate(h.text, 1400)}`)].join('\n\n');
    },

    remember: async (a, { employee }) => {
      if (!eng.memory.available()) return err('This office has no long memory (MemPalace is not installed on its machine, or the owner switched it off).');
      const note = String(a.note ?? '').trim();
      if (note.length < 20) return err('Write the note so that it can be understood without this conversation: what, and why.');
      // A credential in a note goes where credentials go.
      const kept = eng.vault.capture(note, { kind: 'employee', id: employee.id, name: employee.name }, [employee.name]);
      return eng.memory.note(employee, String(a.about ?? ''), kept.text) ? 'Written down. It can be found with recall from now on (give it a moment to be filed).' : err("What is said on a member's own computer stays there: it is not written into the office's shared memory. To keep it for yourself, call propose_context with layer \"self\" — your own notes, which you are given at every start.");
    },

    // A member's team lead's tools (each refuses a caller who is not one).
    ...eng.lead.handlers(),
  };

  const codexUnavailable = new Set(['attach_file', 'vault_read']);

  // A rented employee is given the office's tools only as far as its rental lets it (rent.ts, `toolAllowed`): the rest
  // is neither listed nor answered.
  for (const [name, handler] of Object.entries(handlers)) {
    handlers[name] = async (a, ctx) => {
      if (ctx.session?.mode === 'codex_managed' && (codexUnavailable.has(name) || (name === 'comment_on_task' && a.files?.length))) {
        return err('This Codex session cannot access host files or vault secrets.');
      }
      if (eng.rent.toolAllowed(ctx.employee, name) === false) return err(`While you are rented to ${eng.rent.rentalOf(ctx.employee.id)?.client.name ?? 'a client'}, ${name} is not yours to use. Work with what you have, or ask the boss (ask_boss).`);
      return handler(a, ctx);
    };
  }
  const leadTools = new Set(LEAD_TOOLS.map((t) => t.name));
  // What a lead is shown besides its own tools: how it asks its boss and hears back, and how colleagues reach it. Nothing
  // about tasks of its own — it has none — so that its every turn carries as little as possible.
  const LEAD_ALSO = new Set(['ask_boss', 'wait_for_answer', 'report_status', 'send_message', 'message_person', 'check_messages', 'respond_to_request']);
  const boardTools = new Set(BOARD_TOOLS.map((t) => t.name));
  const memoryTools = new Set(MEMORY_TOOLS.map((t) => t.name));
  return {
    name: 'orchestrator',
    version: '0.1.0',
    instructions:
      'Orchestrator connects you to the virtual office you work in. Use these tools to learn your task, report real progress, ask the boss for decisions, collaborate with teammates and declare work complete. Completion is verified independently, so report honestly.',
    tools: [...ORCHESTRATOR_TOOLS, ...BOARD_TOOLS, ...FILE_TOOLS, ...VAULT_TOOLS, ...MEMORY_TOOLS, ...LEAD_TOOLS],
    handlers,
    // The board tools are shown while the owner leaves the board to the employees.
    listed: (tool, { employee, session }) => (session?.mode !== 'codex_managed' || !codexUnavailable.has(tool.name)) && eng.rent.toolAllowed(employee, tool.name) !== false && (employee.roleKey === LEAD_ROLE ? leadTools.has(tool.name) || LEAD_ALSO.has(tool.name) : !leadTools.has(tool.name)) && tool.name !== 'vault_read' && (tool.name !== 'message_client' || eng.rent.isRented(employee.id)) && (tool.name !== 'report_released' || eng.release.on()) && (!['escalate_review', 'answer_team_question', 'escalate_question'].includes(tool.name) || employee.roleKey === 'pm') && (tool.name !== 'attach_file' || eng.attachments.available()) && (!memoryTools.has(tool.name) || eng.memory.available()) && (!boardTools.has(tool.name) || managing()),
  };
}
