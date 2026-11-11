import type { AgentSession, Employee, Task } from '@orchestrator/contracts';
import { ACTIVITY_LABEL, truncate } from '@orchestrator/contracts';
import type { McpServerOptions, McpToolHandler } from '@orchestrator/integrations';
import { BOARD_TOOLS, FOREMAN_TOOLS, ORCHESTRATOR_TOOLS } from '@orchestrator/integrations';
import type { Engine } from './engine.ts';
import { FOREMAN_ROLE } from './foreman.ts';
import { answerLine } from './prompts.ts';

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
  const lines = [
    `${t.key}: ${t.title}`,
    `Status: ${t.status}${t.status === 'BACKLOG' && !t.released ? ' (not released)' : ''} · Kind: ${t.kind} · Priority: ${t.priority}`,
    `Assigned to: ${core.employees.get(t.assigneeId)?.name ?? 'nobody'}`,
    t.status === 'BLOCKED' ? `Blocked on: ${t.blockedReason ?? 'not said'}` : '',
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
      if (!task) {
        const next = core.tasks.filter((t) => t.assigneeId === employee.id && (t.status === 'READY' || t.status === 'REVIEW' || t.status === 'BLOCKED'));
        return next.length ? `You have no task in progress. Assigned to you: ${next.map((t) => `${t.key} [${t.status}] ${t.title}`).join('; ')}. Wait until one is handed to you.` : 'You have no task right now. Wait for one; do not invent work.';
      }
      return describeTask(eng, task);
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

    ask_boss: async (a, { employee, session }) => {
      const options = Array.isArray(a.options) ? a.options.filter((o: any) => o && typeof o.label === 'string').map((o: any) => ({ label: String(o.label), description: o.description ? String(o.description) : undefined, consequence: o.consequence ? String(o.consequence) : undefined })) : [];
      const q = eng.comms.createQuestion({ kind: a.kind ?? 'question', channel: 'mcp_tool', employee, session, text: String(a.question), context: a.context ? String(a.context) : '', why: a.why ? String(a.why) : '', options });
      eng.sessions.setActivity(session, 'waiting_answer', truncate(q.text, 120));
      const answered = await eng.comms.waitForAnswer(q.id, core.timings.askBossWaitMs);
      if (answered && answered.status === 'answered') {
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
      const task = eng.tasks.blockFromAgent(employee, String(a.reason), a.needs ? String(a.needs) : undefined);
      return task ? `${task.key} is marked BLOCKED and the boss has been alerted. Stop working on it and wait for instructions.` : 'The boss has been alerted that you are blocked.';
    },

    complete_task: async (a, { employee }) => eng.tasks.completeFromAgent(employee, { summary: String(a.summary), tests_run: a.tests_run ? String(a.tests_run) : undefined, no_code_changes: a.no_code_changes === true }),

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
      if (a.reviewer) {
        const r = eng.comms.resolveTeammate(employee, String(a.reviewer));
        if (r) task.reviewerId = r.id;
      }
      core.put('task', task);
      return `${task.key} will go to review${task.reviewerId ? ` by ${core.employees.get(task.reviewerId)?.name}` : ''} once you call complete_task and it passes verification.${a.notes ? ' Put your notes for the reviewer in the complete_task summary.' : ''}`;
    },

    submit_review: async (a, { employee }) => {
      const task = await eng.tasks.submitReview(employee, String(a.task), a.verdict, String(a.comments));
      return a.verdict === 'approve' ? `Approved. ${task.key} is now ${task.status}.` : `Changes requested. ${task.key} goes back to ${core.employees.get(task.assigneeId)?.name ?? 'its author'} with your comments.`;
    },

    send_message: async (a, { employee }) => {
      const to = eng.comms.resolveTeammate(employee, String(a.to));
      if (!to) return { text: `No teammate matches "${a.to}". Use get_team.`, isError: true };
      eng.comms.sendMessage({ from: { kind: 'employee', id: employee.id, name: `${employee.name} (${employee.title})` }, toEmployeeId: to.id, body: String(a.message), taskId: eng.tasks.currentTask(employee.id)?.id ?? null });
      eng.foreman.noteMessage(employee);
      return `Message queued for ${to.name}. It is delivered to their session when they can read it.`;
    },

    hand_off_task: async (a, { employee }) => eng.tasks.handOff(employee, String(a.to), String(a.notes ?? '')),

    request_collaboration: async (a, { employee, session, signal }) => {
      const wait = a.wait === true;
      const target = eng.comms.resolveTeammate(employee, String(a.to));
      // Refused before anything is sent: a request that says "I am waiting" must be one that can be waited for.
      const no = wait && target ? eng.waits.cannotWaitFor(employee, session, target, 'answer') : null;
      if (no) return { text: `${no} Nothing was sent. If they only need to know, send it without wait.`, isError: true };
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
      const task = eng.tasks.currentTask(employee.id);
      const roleOrder = ['architect', 'fullstack', 'backend', 'frontend', 'qa', 'security', 'devops'];
      const helper = core.employees
        .filter((e) => !e.archived && e.id !== employee.id && !!core.runningSessionOf(e.id) && (e.projectId === employee.projectId || !e.projectId))
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

    get_team: async (_a, { employee }) => {
      const team = core.employees.filter((e) => !e.archived && e.id !== employee.id);
      if (!team.length) return 'You are the only employee.';
      return team
        .map((e) => {
          const s = core.runningSessionOf(e.id);
          const t = eng.tasks.currentTask(e.id);
          // What their finished work here shows (counted, not declared): whom to ask about what.
          const record = eng.improver.capture.skillsLine(e);
          const waiting = s?.waitingOn ? ` · waiting for ${eng.waits.words(s.waitingOn)}` : '';
          return `- ${e.name} — ${e.title}${e.projectId === employee.projectId ? '' : ' (other project)'} · ${s ? (ACTIVITY_LABEL[s.activity] ?? s.activity) : 'OFFLINE'}${waiting}${t ? ` · working on ${t.key} "${truncate(t.title, 50)}"` : ''}${record ? ` · ${record}` : ''}`;
        })
        .join('\n');
    },

    get_available_tasks: async (_a, { employee }) => {
      const tasks = core.tasks.filter((t) => t.projectId === employee.projectId && t.status === 'READY' && !t.assigneeId);
      return tasks.length ? tasks.map((t) => `- ${t.key} [${t.priority}] ${t.title}${t.roleHint ? ` (role: ${t.roleHint})` : ''}`).join('\n') : 'No unassigned ready tasks in your project.';
    },

    claim_task: async (a, { employee }) => {
      const task = eng.tasks.taskByKey(String(a.task), employee.projectId);
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
      const { created, existing } = eng.tasks.propose(employee, projectId, a.tasks, a.rationale ? String(a.rationale) : undefined, 'planning');
      // Items a repeating check has already reported: nothing is added, and the employee is told so.
      const already = existing.length ? `Already on the board, so not added again: ${existing.map((t) => `${t.key} [${t.status}]`).join(', ')}.` : '';
      if (!created.length) return `Nothing new was added. ${already}`;
      const waiting = created.filter((t) => !t.released);
      const fate = !waiting.length ? 'They are scheduled automatically as dependencies complete.' : waiting.length === created.length ? 'They wait in the backlog for the boss to release them.' : `${waiting.map((t) => t.key).join(', ')} wait in the backlog for the boss to release them; the rest are scheduled automatically.`;
      return `Created ${created.length} tasks: ${created.map((t) => t.key).join(', ')}. ${fate}${already ? ` ${already}` : ''}`;
    },

    record_lesson: async (a, { employee }) =>
      eng.improver.recordFromAgent(employee, { lesson: a.lesson ? String(a.lesson) : undefined, applies_when: a.applies_when ? String(a.applies_when) : undefined, why: a.why ? String(a.why) : undefined, scope: a.scope, none: a.none === true, reason: a.reason ? String(a.reason) : undefined, replaces: a.replaces ? String(a.replaces) : undefined }),

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
      if (task.blockedReason === 'Blocked by the owner') return err(`The boss blocked ${task.key}. It stays blocked until the boss says otherwise (ask_boss if it matters now).`);
      const note = String(a.note ?? '').trim();
      if (note.length < 12) return err('Say in "note" how the blocker is resolved — what was found, decided or fixed. Whoever picks the task up reads that.');
      const done = eng.tasks.unblock(task.id, truncate(note, 2000), by(employee), employee);
      return `${task.key} is unblocked: ${done.status === 'IN_PROGRESS' ? `${core.employees.get(done.assigneeId)?.name ?? 'its assignee'} was told and continues it` : 'it is back in the queue with your note and is handed out as soon as someone is free'}.`;
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
      if (to.roleKey === FOREMAN_ROLE) return err(`${to.name} is the foreman and does not take tasks. Give it to someone who does the work.`);
      if (!eng.tasks.canSee(to, task)) return err(`${to.name} cannot take ${task.key}: work does not cross between the shared office and a member's own computer.`);
      if (task.assigneeId === to.id) return `${task.key} is already ${to.id === employee.id ? 'yours' : `assigned to ${to.name}`}.`;
      if (task.status === 'IN_PROGRESS') return err(`${core.employees.get(task.assigneeId)?.name ?? 'Someone'} is in the middle of ${task.key}. Talk to them (send_message); they can hand it over themselves.`);
      if (task.status === 'DONE') return err(`${task.key} is done.`);
      eng.tasks.updateTask(task.id, { assigneeId: to.id }, by(employee));
      const next = task.status === 'READY' ? `It is handed to ${to.id === employee.id ? 'you' : 'them'} as soon as ${to.id === employee.id ? 'your turn ends' : 'they are free'}.` : task.status === 'BACKLOG' ? (task.released ? 'It starts once its dependencies are done.' : 'It is not released yet (release_task).') : `It is ${task.status}.`;
      return `${task.key} "${truncate(task.title, 80)}" is now ${to.id === employee.id ? 'yours' : `assigned to ${to.name}`}. ${next}`;
    },

    wake_colleague: async (a, { employee }) => {
      if (!managing()) return OFF;
      const to = eng.comms.resolveTeammate(employee, String(a.employee ?? ''));
      if (!to || to.archived) return err(`No teammate matches "${a.employee}". Use get_team.`);
      const reason = String(a.reason ?? '').trim();
      if (reason.length < 8) return err('Say in "reason" what they are needed for: it is the first thing they read.');
      if (to.roleKey === FOREMAN_ROLE) return err(`${to.name} is the foreman: the office calls it when something needs it. Tell the boss if it should look at something (ask_boss).`);
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

    // Foreman-only tools (each refuses a caller who is not a foreman).
    ...eng.foreman.handlers(),
  };

  const foremanTools = new Set(FOREMAN_TOOLS.map((t) => t.name));
  const boardTools = new Set(BOARD_TOOLS.map((t) => t.name));
  return {
    name: 'orchestrator',
    version: '0.1.0',
    instructions:
      'Orchestrator connects you to the virtual office you work in. Use these tools to learn your task, report real progress, ask the boss for decisions, collaborate with teammates and declare work complete. Completion is verified independently, so report honestly.',
    tools: [...ORCHESTRATOR_TOOLS, ...BOARD_TOOLS, ...FOREMAN_TOOLS],
    handlers,
    // Only a foreman is shown the foreman's tools; everyone else's tool list (and prompt) stays as small as before.
    // The board tools are shown while the owner leaves the board to the employees (a foreman assigns with its own tool).
    listed: (tool, { employee }) => (boardTools.has(tool.name) ? managing() && !(employee.roleKey === FOREMAN_ROLE && tool.name === 'give_task') : employee.roleKey === FOREMAN_ROLE || !foremanTools.has(tool.name)),
  };
}
