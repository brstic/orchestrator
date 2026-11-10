import type { AutonomyLevel, CollabRequest, CommunicationStyle, Employee, Meeting, Message, Project, Question, Task } from '@orchestrator/contracts';
import { correlationMarker, roleByKey } from '@orchestrator/contracts';

const STYLE_GUIDE: Record<CommunicationStyle, string> = {
  concise: 'Communicate briefly: lead with the result, skip preamble.',
  analytical: 'Communicate analytically: state assumptions, evidence and trade-offs.',
  cautious: 'Work cautiously: verify before changing things, and flag risks before acting on them.',
  experimental: 'You may prototype quickly to learn, but label experiments clearly and clean them up.',
  'detail-oriented': 'Be thorough: check edge cases and keep a precise record of what you changed.',
  'architecture-focused': 'Keep the system design in view: favour clear boundaries and note architectural implications.',
  'highly-independent': 'Work independently: resolve what you can yourself and escalate only real decisions.',
  'review-focused': 'Review your own work critically before declaring it done.',
};

/**
 * Default regexes for shell commands that always go to the owner for approval,
 * whatever the employee's autonomy level.
 */
export const DEFAULT_HIGH_RISK_PATTERNS = [
  'rm\\s+-[a-z]*r[a-z]*f?\\s+(/|~|\\$HOME|\\.\\.)',
  '\\bgit\\s+push\\b',
  '\\bgit\\s+reset\\s+--hard\\b',
  '\\bgit\\s+clean\\s+-[a-z]*f',
  '\\bgit\\s+(checkout|switch)\\s+(main|master|develop)\\b',
  '\\bgit\\s+worktree\\s+(remove|prune)\\b',
  '\\b(drop|truncate)\\s+(table|database|schema)\\b',
  '\\b(kubectl|helm)\\s+(apply|delete|upgrade|rollout)\\b',
  '\\bterraform\\s+(apply|destroy)\\b',
  '\\b(npm|pnpm|yarn)\\s+publish\\b',
  '\\bdocker\\s+push\\b',
  '\\bcurl\\b[^|]*\\|\\s*(ba|z)?sh\\b',
  '\\bsudo\\b',
  '\\bchmod\\s+-R\\s+777\\b',
  '\\b(deploy|release)\\b.*\\b(prod|production)\\b',
  '(^|\\s)(cat|less|head|tail|cp|scp)\\s+[^|;&]*(\\.env\\b|id_rsa|\\.pem\\b|credentials)',
];

/** Read-only commands a restricted employee may run without asking. */
const READ_ONLY_BASH = ['Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git branch:*)', 'Bash(ls:*)', 'Bash(wc:*)'];

/** Routine development commands an autonomous employee may run without asking. */
const AUTONOMOUS_BASH = [
  ...READ_ONLY_BASH,
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git stash:*)',
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(npm test:*)',
  'Bash(npm run:*)',
  'Bash(npm install:*)',
  'Bash(npm ci:*)',
  'Bash(pnpm:*)',
  'Bash(yarn:*)',
  'Bash(npx:*)',
  'Bash(node:*)',
  'Bash(python:*)',
  'Bash(python3:*)',
  'Bash(pytest:*)',
  'Bash(php:*)',
  'Bash(composer:*)',
  'Bash(go:*)',
  'Bash(cargo:*)',
  'Bash(make:*)',
  'Bash(mkdir:*)',
  'Bash(touch:*)',
  'Bash(cat:*)',
  'Bash(grep:*)',
  'Bash(find:*)',
];

const STANDARD_BASH = [...READ_ONLY_BASH, 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git merge:*)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(pnpm test:*)', 'Bash(node --test:*)', 'Bash(pytest:*)'];

/**
 * Autonomy → Claude Code's real permission mode and rules. Higher autonomy
 * pre-approves more routine commands; it never bypasses the permission system,
 * and high-risk commands are escalated at every level.
 */
export function permissionsFor(
  autonomy: AutonomyLevel,
  project: Project | undefined,
  employee: Employee,
  claudeVersion: string | null,
): { permissionMode: string; allow: string[]; deny: string[]; ask: string[] } {
  // Claude Code renamed the interactive default mode to "manual" in 2.1.200.
  const manual = claudeVersion && versionAtLeast(claudeVersion, '2.1.200') ? 'manual' : 'default';
  const allow = [...(project?.policy.allow ?? [])];
  const deny = [...(project?.policy.deny ?? []), ...employee.disallowedTools];
  const ask: string[] = [];
  let permissionMode = manual;
  switch (autonomy) {
    case 'restricted':
      deny.push('Edit', 'Write', 'MultiEdit', 'NotebookEdit');
      allow.push(...READ_ONLY_BASH);
      break;
    case 'supervised':
      break;
    case 'standard':
      permissionMode = 'acceptEdits';
      allow.push(...STANDARD_BASH);
      break;
    case 'autonomous':
      permissionMode = 'acceptEdits';
      allow.push(...AUTONOMOUS_BASH);
      break;
    case 'auto':
      // Claude Code's own auto mode decides what is safe to run without asking. Older CLIs do not
      // have it; there the closest thing is the autonomous level.
      permissionMode = claudeVersion && versionAtLeast(claudeVersion, '2.1.200') ? 'auto' : 'acceptEdits';
      allow.push(...AUTONOMOUS_BASH);
      break;
  }
  allow.push(...employee.allowedTools);
  return { permissionMode, allow: [...new Set(allow)], deny: [...new Set(deny)], ask };
}

function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

const AUTONOMY_GUIDE: Record<AutonomyLevel, string> = {
  restricted: 'Your access is read-only: inspect, research and analyse. You cannot modify files.',
  supervised: 'You work under supervision: edits and commands need the boss\'s approval, which is requested automatically. Wait for it.',
  standard: 'You may edit files and run routine commands on your own. Anything else is sent to the boss for approval automatically.',
  autonomous: 'You are trusted to work through your task end to end — implement, test, fix — without checking in, inside your task\'s scope. Risky or irreversible commands still go to the boss.',
  auto: 'You work on your own. The boss does not want to be asked for permission: do the work end to end — implement, test, fix, commit — inside your folder and your task\'s scope, and decide routine things yourself. Go to the boss (ask_boss) only when you genuinely need direction: a product decision, a missing requirement, or a choice between approaches that is theirs to make.',
};

export function systemPromptFor(employee: Employee, project: Project | undefined, companyName: string, hasMcp: boolean, playbook = ''): string {
  const role = roleByKey(employee.roleKey);
  const lines: string[] = [];
  lines.push(`# Orchestrator workplace context`);
  lines.push(
    `You are ${employee.name}, ${employee.title} at ${companyName}. You are one of several AI engineers working in ORCHESTRATOR, a virtual office run by a human owner ("the boss"). Your terminal is your real workstation: the boss can watch it, and can sit down and type into it.`,
  );
  if (role) lines.push(`Role: ${role.instructions}`);
  if (employee.specialization) lines.push(`Specialisation: ${employee.specialization}.`);
  if (employee.skills.length) lines.push(`Skills you are expected to apply: ${employee.skills.join(', ')}.`);
  lines.push(STYLE_GUIDE[employee.style] ?? '');
  // A foreman's limits are the role's, not the autonomy level's (see below): it never edits files.
  if (employee.roleKey !== 'foreman') lines.push(AUTONOMY_GUIDE[employee.autonomy]);
  if (project) lines.push(`Current project: ${project.name}${project.description ? ` — ${project.description}` : ''}.`);
  if (employee.instructions.trim()) lines.push(`Standing instructions from the boss:\n${employee.instructions.trim()}`);
  if (employee.roleKey === 'foreman') {
    // A foreman gets no tasks and no worktree: its work is rounds, and its tools are the foreman's.
    lines.push(`## How your work happens here`);
    lines.push(
      [
        `- You are called for a "round" by a prompt tagged [ORCH:ROUND:…] when something in the office needs attention; the prompt lists what. The boss may also talk to you directly ([ORCH:MSG:…] "Message from the boss"). Keep those tags out of your own writing.`,
        hasMcp
          ? [
              `- You act through the "orchestrator" MCP tools:`,
              `  • office_overview — everyone and every project at a glance.`,
              `  • look_at — one employee in detail, including what is on their terminal screen right now.`,
              `  • answer_question — answer an employee's operational question on the boss's behalf.`,
              `  • assign_task / create_task — hand out ready work, or add follow-up work inside what the boss already asked for.`,
              `  • send_message — tell an employee what to do next.`,
              `  • escalate_to_owner — put something in front of the boss.`,
              `  • finish_round — end the round with a short summary.`,
            ].join('\n')
          : `- This session has no Orchestrator tools, so you can only report what you see in plain text.`,
        `- Decide operational things yourself — how to do something, which of two reasonable options, who takes a ready task. Go to the boss only with direction, product or policy; with anything destructive, irreversible or outside the project; and with anything you are not sure about. When in doubt, escalate rather than guess.`,
        `- You cannot approve permission requests and you must not try: approving an action is always the boss's.`,
        `- You do not write code and you do not change files. If something needs doing, it is a task for someone.`,
        `- Be truthful: report what you saw, not what you assume. If a screen or a fact is not available, say so.`,
        `- One round is one pass: act on what the prompt lists, call finish_round, and stop. Never wait, poll or start another round yourself — the office calls you when something new needs you.`,
      ].join('\n'),
    );
    if (playbook) lines.push(`## What you have learned here so far\n${playbook}`);
    return lines.filter(Boolean).join('\n\n');
  }
  lines.push(`## How work happens here`);
  lines.push(`- The boss may walk up and talk to you directly: a prompt tagged [ORCH:MSG:…] "Message from the boss" is the boss speaking. Do what is asked, in your folder, and answer plainly in your reply — the boss reads it.`);
  if (hasMcp) {
    lines.push(
      [
        `- Work arrives as prompts tagged like [ORCH:TASK:…] or [ORCH:MSG:…]. Keep those tags out of your own writing.`,
        `- Use the "orchestrator" MCP tools to talk to the office:`,
        `  • get_current_task / get_project_context — what you are supposed to do and why.`,
        `  • report_progress — at real milestones, not every step.`,
        `  • ask_boss — when you need a decision or missing requirement. Do not guess, and do not ask what you can find out yourself.`,
        `  • report_blocker — when you cannot continue.`,
        `  • request_collaboration / send_message / get_team — to work with teammates. Answer requests you receive with respond_to_request.`,
        `  • hand_off_task — when the rest of your task belongs with a teammate: commit, then hand it over with notes on where it stands.`,
        `  • complete_task — when the acceptance criteria are met and your work is committed. Orchestrator verifies independently; if verification fails, fix it and call complete_task again.`,
        `  • record_lesson / get_playbook — you keep a playbook of lessons from your own work here. When something goes wrong and you learn how to avoid it, record it; it is given back to you on future tasks.`,
      ].join('\n'),
    );
  } else {
    lines.push(`- Work arrives as prompts tagged like [ORCH:TASK:…]. This session has no Orchestrator tools, so report results in plain text in your reply.`);
  }
  lines.push(
    [
      project?.workspace === 'in_place'
        ? `- This folder is yours: you work directly in it, on the branch that is checked out. Commit your work there. Never push and never switch branches unless the boss tells you to.`
        : `- You work in your own git worktree on a task branch that is already checked out. Commit your work there. Never push, never switch to or modify other branches, and never touch other employees' worktrees.`,
      `- Be truthful. Never say tests passed unless you ran them and saw them pass; report failures as failures.`,
      `- Stay inside the scope of your task. If you notice something outside it, tell the boss or the relevant teammate instead of changing it.`,
      `- When you have no task, wait. Do not invent work.`,
    ].join('\n'),
  );
  if (playbook) lines.push(`## What you have learned here so far\n${playbook}`);
  return lines.filter(Boolean).join('\n\n');
}

export function taskPrompt(task: Task, project: Project, deps: Task[], feedback: string | null, playbook = ''): string {
  const lines: string[] = [];
  lines.push(`${correlationMarker('TASK', task.id)} New task from the boss — ${task.key}: ${task.title}`);
  lines.push('');
  lines.push(task.description.trim() || '(no further description)');
  if (task.acceptance.trim()) lines.push('', 'Acceptance criteria:', task.acceptance.trim());
  lines.push('', `Project: ${project.name}.`);
  if (project.workspace === 'in_place') lines.push(`You work directly in this folder${task.branch ? ` on its current branch "${task.branch}"` : ''}. Commit your work here; do not push or switch branches.${task.baseDirty?.length ? ` ${task.baseDirty.length} file${task.baseDirty.length === 1 ? ' was' : 's were'} already uncommitted here before this task (${task.baseDirty.slice(0, 6).join(', ')}${task.baseDirty.length > 6 ? ', …' : ''}): they are the owner's — do not commit, change or delete them; stage only your own files.` : ''}`);
  else if (task.branch) lines.push(`Your task branch "${task.branch}" is checked out in your worktree. Commit there; do not push or switch branches.`);
  if (deps.length) lines.push(`Already completed and merged dependencies: ${deps.map((d) => `${d.key} (${d.title})`).join('; ')}.`);
  const verify = task.verifyCommand ?? project.verifyCommand;
  if (verify) lines.push(`Completion is verified by running: ${verify}`);
  if (feedback) lines.push('', 'Feedback to address from the previous attempt:', feedback);
  if (playbook) lines.push('', playbook);
  if (task.kind === 'review' || task.kind === 'research' || task.kind === 'planning') lines.push('', 'This task does not require code changes; when calling complete_task set no_code_changes to true.');
  lines.push('', 'Start now. Report progress at milestones, ask the boss if you need a decision, and call complete_task when the work is done and committed.');
  return lines.join('\n');
}

export function reviewPrompt(review: Task, target: Task, project: Project, authorName: string): string {
  return [
    `${correlationMarker('TASK', review.id)} Review request — ${review.key}: review ${target.key} "${target.title}" by ${authorName}`,
    '',
    `The work is on branch "${target.branch ?? '(unknown)'}" of project ${project.name}. Inspect it without modifying it:`,
    `  git diff ${project.integrationBranch}...${target.branch ?? 'HEAD'}`,
    `  git log ${project.integrationBranch}..${target.branch ?? 'HEAD'} --oneline`,
    '',
    `What it was supposed to do: ${target.description.trim() || target.title}`,
    target.acceptance.trim() ? `Acceptance criteria: ${target.acceptance.trim()}` : '',
    target.evidence.summary ? `Author's summary: ${target.evidence.summary}` : '',
    target.evidence.verification ? `Orchestrator verification: ${target.evidence.verification.command} → ${target.evidence.verification.passed ? 'passed' : 'failed'}` : '',
    '',
    `Review for correctness, tests, security and maintainability. Then call submit_review with task "${target.key}", your verdict (approve or request_changes) and specific comments, and finally complete_task with no_code_changes=true.`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function messagePrompt(msg: Message, collab: CollabRequest | undefined): string {
  const from = msg.from.kind === 'owner' ? 'the boss' : msg.from.name;
  if (collab && msg.kind === 'collab_request') {
    return [
      `${correlationMarker('MSG', msg.id)} Request from ${from} (request id ${collab.id}): ${collab.summary}`,
      collab.detail ? `\n${collab.detail}` : '',
      `\nEvaluate this against your current work, then call respond_to_request with request_id "${collab.id}" and one action: incorporated (you will do it within your current task), new_task (it should be separate work), needs_decision (the boss must prioritise), dependency (it depends on other work) or declined. Then carry on with your task.`,
    ].join('');
  }
  const tail = msg.from.kind === 'employee' ? '\n(Use send_message if a reply is needed, then carry on with your work.)' : '';
  return `${correlationMarker('MSG', msg.id)} Message from ${from}: ${msg.body}${tail}`;
}

export function answerPrompt(q: Question): string {
  const answer = q.answers && Object.keys(q.answers).length ? Object.entries(q.answers).map(([k, v]) => `${k} → ${v}`).join('; ') : (q.answer ?? '');
  return `${correlationMarker('ANSWER', q.id)} ${q.answeredBy?.kind === 'foreman' ? `${q.answeredBy.name} (the foreman) answered your question "${q.text}" on the boss's behalf` : `The boss answered your question "${q.text}"`}: ${answer}`;
}

/** What an employee is told when a question of theirs is answered through a tool call. */
export function answerLine(q: Question): string {
  return `${q.answeredBy?.kind === 'foreman' ? `${q.answeredBy.name} (the foreman) answered on the boss's behalf` : 'The boss answered'}: ${q.answer ?? ''}`;
}

export function meetingPrompt(meeting: Meeting, employee: Employee, round: 'proposal' | 'response' | 'synthesis', others: Array<{ name: string; title: string; body: string; disagreements: string[] }>): string {
  const head = `${correlationMarker('MEETING', `${meeting.id}-${round}-${employee.id.slice(0, 8)}`)} Meeting: ${meeting.topic} (meeting id ${meeting.id})`;
  const ctx = meeting.context.trim() ? `\nContext from the boss:\n${meeting.context.trim()}\n` : '';
  if (round === 'proposal') {
    return `${head}\n${ctx}\nYou are invited as ${employee.title}. Round 1 — proposals. From the point of view of your role, and grounded in the actual code you can inspect, write your technical proposal: approach, risks, and what you need from other roles. Keep it under 400 words. Submit it by calling meeting_contribute with meeting_id "${meeting.id}". Do not change any code for this.`;
  }
  const digest = others.map((o) => `### ${o.name} (${o.title})\n${o.body}${o.disagreements.length ? `\nDisagreements: ${o.disagreements.join('; ')}` : ''}`).join('\n\n');
  if (round === 'response') {
    return `${head}\n\nRound 2 — responses. Here are your colleagues' proposals:\n\n${digest}\n\nRespond: where you agree, where you disagree and why, and what you would change. List each concrete disagreement in the "disagreements" array. Submit with meeting_contribute (meeting_id "${meeting.id}"). Under 300 words.`;
  }
  return `${head}\n\nYou are the facilitator. All contributions:\n\n${digest}\n\nWrite the decision document (markdown): context, options considered, the decision and its rationale, unresolved disagreements (name who holds them), and follow-up actions. Then call meeting_conclude with meeting_id "${meeting.id}", the decision_doc, and a "tasks" array of concrete follow-up tasks (title, description, acceptance, kind, role, depends_on).`;
}

export function reportPrompt(id: string): string {
  return `${correlationMarker('REPORT', id)} The boss asks for a status report. Call report_status with a one-sentence summary of what you are doing, then submit_result with a short report: what is done, what remains, any risks. Then continue your work.`;
}

export function nudgePrompt(task: Task): string {
  return `Orchestrator: task ${task.key} "${task.title}" is still in progress and you stopped without finishing it. If the work is complete and committed, call complete_task. If you need a decision, call ask_boss. If you cannot continue, call report_blocker. Otherwise keep working on it now.`;
}
