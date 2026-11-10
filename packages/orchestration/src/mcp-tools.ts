import type { AgentSession, Employee, Task } from '@orchestrator/contracts';
import { ACTIVITY_LABEL, truncate } from '@orchestrator/contracts';
import type { McpServerOptions, McpToolHandler } from '@orchestrator/integrations';
import { FOREMAN_TOOLS, ORCHESTRATOR_TOOLS } from '@orchestrator/integrations';
import type { Engine } from './engine.ts';
import { FOREMAN_ROLE } from './foreman.ts';
import { answerLine } from './prompts.ts';

/** Who is calling: resolved from the session's bearer token, never from tool arguments. */
export interface McpContext {
  session: AgentSession;
  employee: Employee;
}

function describeTask(eng: Engine, t: Task): string {
  const core = eng.core;
  const project = core.projects.get(t.projectId);
  const deps = t.dependsOn.map((id) => core.tasks.get(id)).filter((x): x is Task => !!x);
  const lines = [
    `${t.key}: ${t.title}`,
    `Status: ${t.status} · Kind: ${t.kind} · Priority: ${t.priority}`,
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

    request_collaboration: async (a, { employee }) => {
      const collab = eng.comms.requestCollaboration(employee, String(a.to), String(a.summary), a.detail ? String(a.detail) : '');
      const to = core.employees.get(collab.toEmployeeId);
      return `Request ${collab.id} sent to ${to?.name} (${to?.title}). They will respond; the response is delivered to you. Continue with what you can in the meantime.`;
    },

    request_help: async (a, { employee, session }) => {
      const task = eng.tasks.currentTask(employee.id);
      const roleOrder = ['architect', 'fullstack', 'backend', 'frontend', 'qa', 'security', 'devops'];
      const helper = core.employees
        .filter((e) => !e.archived && e.id !== employee.id && !!core.runningSessionOf(e.id) && (e.projectId === employee.projectId || !e.projectId))
        .sort((x, y) => roleOrder.indexOf(x.roleKey) - roleOrder.indexOf(y.roleKey))
        .find((e) => roleOrder.includes(e.roleKey));
      if (helper) {
        const collab = eng.comms.requestCollaboration(employee, helper.name, `Help needed: ${String(a.topic)}`, a.detail ? String(a.detail) : '');
        return `Help request ${collab.id} sent to ${helper.name} (${helper.title}).`;
      }
      const q = eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee, session, text: `${employee.name} needs help: ${String(a.topic)}`, context: a.detail ? String(a.detail) : '', why: task ? `They are working on ${task.key}.` : '' });
      return `No teammate is available to help, so the boss was asked (question id ${q.id}). Call wait_for_answer to wait for a reply.`;
    },

    respond_to_request: async (a, { employee }) => {
      const collab = eng.comms.respondToRequest(employee, String(a.request_id), a.action, String(a.note));
      return `Response recorded (${collab.status}) and sent to ${core.employees.get(collab.fromEmployeeId)?.name}.`;
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
          return `- ${e.name} — ${e.title}${e.projectId === employee.projectId ? '' : ' (other project)'} · ${s ? (ACTIVITY_LABEL[s.activity] ?? s.activity) : 'OFFLINE'}${t ? ` · working on ${t.key} "${truncate(t.title, 50)}"` : ''}`;
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
      const created = eng.tasks.proposeTasks(employee, projectId, a.tasks, a.rationale ? String(a.rationale) : undefined, 'planning');
      const released = core.projects.get(projectId)?.policy.autoAssign;
      return `Created ${created.length} tasks: ${created.map((t) => t.key).join(', ')}. ${released ? 'They are scheduled automatically as dependencies complete.' : 'They wait in the backlog for the boss to release them.'}`;
    },

    record_lesson: async (a, { employee }) => eng.improver.recordFromAgent(employee, { lesson: a.lesson ? String(a.lesson) : undefined, applies_when: a.applies_when ? String(a.applies_when) : undefined, scope: a.scope, none: a.none === true }),

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
          eng.improver.recordFromAgent(employee, { lesson: String(lesson), applies_when: `agreed in meeting ${a.meeting_id}`, scope: 'project' });
          recorded++;
        } catch {
          /* skip malformed entries */
        }
      }
      return recorded ? `${text} ${recorded} team lesson${recorded === 1 ? '' : 's'} recorded.` : text;
    },

    // Foreman-only tools (each refuses a caller who is not a foreman).
    ...eng.foreman.handlers(),
  };

  const foremanTools = new Set(FOREMAN_TOOLS.map((t) => t.name));
  return {
    name: 'orchestrator',
    version: '0.1.0',
    instructions:
      'Orchestrator connects you to the virtual office you work in. Use these tools to learn your task, report real progress, ask the boss for decisions, collaborate with teammates and declare work complete. Completion is verified independently, so report honestly.',
    tools: [...ORCHESTRATOR_TOOLS, ...FOREMAN_TOOLS],
    handlers,
    // Only a foreman is shown the foreman's tools; everyone else's tool list (and prompt) stays as small as before.
    listed: (tool, { employee }) => employee.roleKey === FOREMAN_ROLE || !foremanTools.has(tool.name),
  };
}
