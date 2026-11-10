import path from 'node:path';
import type { ActivityState, EventType, HookPayload } from '@orchestrator/contracts';
import { parseCorrelationMarkers, redactSecrets, truncate } from '@orchestrator/contracts';

/**
 * Claude Code hook → normalized Orchestrator events + activity state.
 *
 * This is a pure function over the real hook payload. It is the only place
 * where an employee's visible state is derived, so the office can never show
 * work that Claude Code did not report.
 */
export interface HookInterpretation {
  events: Array<{ type: EventType; summary: string; data: Record<string, unknown>; quiet?: boolean }>;
  /** null = this hook does not change what the employee is doing. */
  activity: { state: ActivityState; detail: string | null } | null;
  toolName: string | null;
  /** Name of the Orchestrator MCP tool being called, without the mcp__orchestrator__ prefix. */
  orchestratorTool: string | null;
  isTestCommand: boolean;
  testOutcome: 'passed' | 'failed' | null;
  /** A deployment or release command that just finished in this worker's terminal. */
  deployment: { kind: 'release' | 'deploy'; what: string; ok: boolean } | null;
  fileModified: string | null;
  markers: Array<{ kind: string; id: string }>;
  turnFinished: boolean;
  sessionEnded: boolean;
  sessionStarted: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | null;
}

export interface HookContext {
  employeeName: string;
  /** A test run failed recently and has not passed since. */
  debugging: boolean;
  taskKind: string | null;
  activeSubagents: number;
}

const TEST_COMMAND =
  /(^|[\s;&|(])(npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+(run\s+)?test|bun\s+test|npx\s+(jest|vitest|mocha|playwright|cypress)|jest|vitest|mocha|pytest|python3?\s+-m\s+(pytest|unittest)|phpunit|artisan\s+test|go\s+test|cargo\s+test|rspec|node\s+--test|deno\s+test|gradle\w*\s+test|mvn\s+test|ctest|make\s+test|tox|dotnet\s+test|playwright\s+test)\b/;

export function isTestCommand(command: string): boolean {
  // Quoted text is data (a commit message mentioning "npm test" is not a test run).
  const bare = command.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");
  return TEST_COMMAND.test(bare);
}

/** Commands that put something somewhere others will use it. `release` ones publish a version; the rest deploy. */
const DEPLOY_COMMANDS: Array<{ kind: 'release' | 'deploy'; what: string; re: RegExp }> = [
  { kind: 'release', what: 'package publish', re: /(^|[\s;&|(])(npm|pnpm|yarn|bun)\s+publish\b|(^|[\s;&|(])(cargo\s+publish|twine\s+upload|gem\s+push|poetry\s+publish)\b/ },
  { kind: 'release', what: 'GitHub release', re: /(^|[\s;&|(])gh\s+release\s+create\b/ },
  { kind: 'release', what: 'version tag', re: /(^|[\s;&|(])git\s+push\b[^;&|]*(--tags\b|\bv?\d+\.\d+\.\d+)|(^|[\s;&|(])git\s+tag\s+(-a\s+|-s\s+)?v?\d+\.\d+/ },
  { kind: 'release', what: 'image push', re: /(^|[\s;&|(])(docker|podman)\s+(image\s+)?push\b/ },
  { kind: 'deploy', what: 'git push', re: /(^|[\s;&|(])git\s+push\b/ },
  { kind: 'deploy', what: 'Kubernetes', re: /(^|[\s;&|(])(kubectl\s+(apply|rollout|set\s+image)|helm\s+(upgrade|install))\b/ },
  { kind: 'deploy', what: 'Terraform', re: /(^|[\s;&|(])(terraform|tofu|pulumi)\s+(apply|up)\b/ },
  { kind: 'deploy', what: 'platform deploy', re: /(^|[\s;&|(])(vercel(\s+deploy|\s+--prod)|netlify\s+deploy|fly(ctl)?\s+deploy|firebase\s+deploy|wrangler\s+(deploy|publish)|serverless\s+deploy|sls\s+deploy|railway\s+up|heroku\s+container:release|cap\s+\S+\s+deploy|ansible-playbook)\b/ },
  { kind: 'deploy', what: 'cloud deploy', re: /(^|[\s;&|(])(gcloud\s+[^;&|]*\bdeploy|aws\s+[^;&|]*\b(deploy|s3\s+sync|update-service|update-function-code)|az\s+[^;&|]*\bdeploy)\b/ },
  { kind: 'deploy', what: 'compose up', re: /(^|[\s;&|(])docker(\s+|-)compose\s+[^;&|]*\bup\b/ },
  { kind: 'deploy', what: 'deploy script', re: /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?(deploy|release)|make\s+(deploy|release))\b/ },
];

/** Whether a shell command deploys or releases something (quoted text is data, as with test commands). */
export function deployCommand(command: string): { kind: 'release' | 'deploy'; what: string } | null {
  const bare = command.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");
  if (/--dry-run\b|--help\b/.test(bare)) return null;
  const hit = DEPLOY_COMMANDS.find((d) => d.re.test(bare));
  return hit ? { kind: hit.kind, what: hit.what } : null;
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const RESEARCH_TOOLS = new Set(['WebFetch', 'WebSearch']);
const DELEGATE_TOOLS = new Set(['Task', 'Agent']);
const PLAN_TOOLS = new Set(['TodoWrite', 'ExitPlanMode', 'EnterPlanMode', 'TaskCreate', 'TaskUpdate']);

function rel(file: unknown, cwd: string | undefined): string {
  const f = String(file ?? '');
  if (!f) return '';
  if (cwd && f.startsWith(cwd + path.sep)) return f.slice(cwd.length + 1);
  return f;
}

/** One-line description of a tool call, built only from its real input. */
export function describeTool(name: string, input: any, cwd?: string): string {
  if (!input || typeof input !== 'object') return name;
  if (WRITE_TOOLS.has(name) || name === 'Read' || name === 'NotebookRead') return `${name} ${rel(input.file_path ?? input.notebook_path, cwd)}`.trim();
  if (name === 'Bash') return `$ ${truncate(redactSecrets(String(input.command ?? '')).replace(/\s+/g, ' '), 120)}`;
  if (name === 'Grep') return `Grep "${truncate(String(input.pattern ?? ''), 60)}"`;
  if (name === 'Glob') return `Glob ${truncate(String(input.pattern ?? ''), 60)}`;
  if (name === 'WebFetch') return `WebFetch ${truncate(String(input.url ?? ''), 80)}`;
  if (name === 'WebSearch') return `WebSearch "${truncate(String(input.query ?? ''), 60)}"`;
  if (DELEGATE_TOOLS.has(name)) return `${name}: ${truncate(String(input.description ?? input.subagent_type ?? ''), 60)}`;
  if (name.startsWith('mcp__')) return name.replace(/^mcp__/, '').replace(/__/g, '.');
  return name;
}

/** Keep only small, non-sensitive parts of a tool input for the event store. */
export function summarizeToolInput(name: string, input: any, cwd?: string): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, unknown> = {};
  if (input.file_path) out.file = rel(input.file_path, cwd);
  if (input.notebook_path) out.file = rel(input.notebook_path, cwd);
  if (typeof input.command === 'string') out.command = truncate(redactSecrets(input.command), 400);
  if (typeof input.description === 'string') out.description = truncate(input.description, 160);
  if (typeof input.pattern === 'string') out.pattern = truncate(input.pattern, 120);
  if (typeof input.url === 'string') out.url = truncate(input.url, 200);
  if (typeof input.query === 'string') out.query = truncate(input.query, 160);
  if (typeof input.subagent_type === 'string') out.subagent = input.subagent_type;
  return out;
}

function toolActivity(name: string, input: any, ctx: HookContext, cwd?: string): { state: ActivityState; detail: string | null } | null {
  const detail = describeTool(name, input, cwd);
  if (name === 'AskUserQuestion') return { state: 'waiting_answer', detail: 'Asking a question' };
  if (name.startsWith('mcp__orchestrator__')) {
    const tool = name.slice('mcp__orchestrator__'.length);
    if (tool === 'ask_boss' || tool === 'wait_for_answer') return { state: 'waiting_answer', detail: 'Waiting for the boss' };
    // Reporting to Orchestrator is bookkeeping, not a change in what the employee is doing.
    return null;
  }
  if (READ_TOOLS.has(name)) {
    if (ctx.taskKind === 'review') return { state: 'reviewing', detail };
    if (ctx.taskKind === 'planning') return { state: 'planning', detail };
    return { state: 'reading', detail };
  }
  if (WRITE_TOOLS.has(name)) return { state: ctx.debugging ? 'debugging' : 'coding', detail };
  if (name === 'Bash') {
    const command = String(input?.command ?? '');
    if (isTestCommand(command)) return { state: 'testing', detail };
    if (ctx.taskKind === 'review' && /\bgit\s+(diff|log|show)\b/.test(command)) return { state: 'reviewing', detail };
    return { state: ctx.debugging ? 'debugging' : 'running_command', detail };
  }
  if (RESEARCH_TOOLS.has(name)) return { state: 'researching', detail };
  if (DELEGATE_TOOLS.has(name)) return { state: 'delegating', detail };
  if (PLAN_TOOLS.has(name)) return { state: 'planning', detail: name === 'TodoWrite' ? 'Updating plan' : detail };
  return { state: 'running_command', detail };
}

function looksFailed(response: any): boolean {
  if (!response || typeof response !== 'object') return false;
  if (response.interrupted === true) return true;
  if (typeof response.exitCode === 'number' && response.exitCode !== 0) return true;
  if (typeof response.exit_code === 'number' && response.exit_code !== 0) return true;
  if (response.is_error === true || response.isError === true) return true;
  return false;
}

export function interpretHook(payload: HookPayload, ctx: HookContext): HookInterpretation {
  const out: HookInterpretation = {
    events: [],
    activity: null,
    toolName: payload.tool_name ?? null,
    orchestratorTool: payload.tool_name?.startsWith('mcp__orchestrator__') ? payload.tool_name.slice('mcp__orchestrator__'.length) : null,
    isTestCommand: false,
    deployment: null,
    testOutcome: null,
    fileModified: null,
    markers: [],
    turnFinished: false,
    sessionEnded: false,
    sessionStarted: null,
  };
  const who = ctx.employeeName;
  const cwd = payload.cwd;
  const tool = payload.tool_name ?? '';
  const input = payload.tool_input;
  const command = tool === 'Bash' ? String(input?.command ?? '') : '';
  if (command) out.isTestCommand = isTestCommand(command);
  const step = (p: any): string => truncate(redactSecrets(String(p.task_subject ?? '')), 160) || '(untitled)';
  /** A deployment or release command finished: say so, with whether it worked. */
  const deployed = (ok: boolean): void => {
    const d = command ? deployCommand(command) : null;
    if (!d) return;
    out.deployment = { ...d, ok };
    out.events.push({
      type: 'ops.deployment',
      summary: `${who} ${d.kind === 'release' ? 'released' : 'deployed'} (${d.what}): ${ok ? 'succeeded' : 'failed'}`,
      data: { kind: d.kind, what: d.what, ok, command: truncate(redactSecrets(command.replace(/\s+/g, ' ')), 300) },
    });
  };

  switch (payload.hook_event_name) {
    case 'SessionStart': {
      const source = (payload.source as HookInterpretation['sessionStarted']) ?? 'startup';
      out.sessionStarted = source;
      if (source === 'resume') out.events.push({ type: 'session.resumed', summary: `${who} resumed their Claude Code session`, data: { source } });
      else if (source === 'startup') out.events.push({ type: 'session.started', summary: `${who} started a Claude Code session`, data: { source } });
      else out.events.push({ type: 'session.started', summary: `${who}'s session context was reset (${source})`, data: { source }, quiet: true });
      if (source === 'startup' || source === 'resume') out.activity = { state: 'idle', detail: null };
      break;
    }
    case 'SessionEnd':
      out.sessionEnded = true;
      out.events.push({ type: 'session.stopped', summary: `${who}'s Claude Code session ended (${payload.reason ?? 'unknown'})`, data: { reason: payload.reason ?? null } });
      // "clear" and "resume" end one conversation but the process keeps going.
      if (payload.reason !== 'clear' && payload.reason !== 'resume') out.activity = { state: 'offline', detail: null };
      break;
    case 'UserPromptSubmit': {
      const prompt = String(payload.prompt ?? '');
      out.markers = parseCorrelationMarkers(prompt);
      out.events.push({
        type: 'agent.prompt_submitted',
        summary: `${who} received a prompt`,
        data: { prompt: truncate(redactSecrets(prompt), 500), markers: out.markers },
        quiet: true,
      });
      out.activity = { state: 'thinking', detail: null };
      break;
    }
    case 'PreToolUse': {
      if (!out.orchestratorTool) {
        out.events.push({
          type: 'agent.tool_started',
          summary: `${who}: ${describeTool(tool, input, cwd)}`,
          data: { tool, toolUseId: payload.tool_use_id ?? null, input: summarizeToolInput(tool, input, cwd), highRisk: payload.orch_policy === 'high_risk' },
          quiet: true,
        });
      }
      out.activity = toolActivity(tool, input, ctx, cwd);
      break;
    }
    case 'PostToolUse': {
      const failed = looksFailed(payload.tool_response);
      if (WRITE_TOOLS.has(tool)) {
        out.fileModified = rel(input?.file_path ?? input?.notebook_path, cwd) || null;
        out.events.push({
          type: 'agent.tool_finished',
          summary: `${who} modified ${out.fileModified ?? 'a file'}`,
          data: { tool, toolUseId: payload.tool_use_id ?? null, file: out.fileModified, durationMs: payload.duration_ms ?? null },
        });
      } else if (out.isTestCommand) {
        out.testOutcome = failed ? 'failed' : 'passed';
        out.events.push({
          type: failed ? 'agent.tool_failed' : 'agent.tool_finished',
          summary: failed ? `${who}'s test run failed` : `${who} ran tests: ${truncate(command.replace(/\s+/g, ' '), 80)}`,
          data: { tool, toolUseId: payload.tool_use_id ?? null, command: truncate(redactSecrets(command), 400), durationMs: payload.duration_ms ?? null, test: true },
        });
      } else if (!out.orchestratorTool) {
        out.events.push({
          type: 'agent.tool_finished',
          summary: `${who} finished ${describeTool(tool, input, cwd)}`,
          data: { tool, toolUseId: payload.tool_use_id ?? null, input: summarizeToolInput(tool, input, cwd), durationMs: payload.duration_ms ?? null },
          quiet: true,
        });
      }
      if (!out.orchestratorTool || out.orchestratorTool === 'ask_boss' || out.orchestratorTool === 'wait_for_answer') {
        out.activity = { state: ctx.activeSubagents > 0 ? 'delegating' : 'thinking', detail: null };
      }
      deployed(!failed);
      break;
    }
    case 'PostToolUseFailure': {
      if (out.isTestCommand) out.testOutcome = 'failed';
      if (payload.is_interrupt !== true) deployed(false);
      const interrupted = payload.is_interrupt === true;
      out.events.push({
        type: 'agent.tool_failed',
        summary: out.isTestCommand ? `${who}'s test run failed` : `${who}: ${describeTool(tool, input, cwd)} ${interrupted ? 'was interrupted' : 'failed'}`,
        data: {
          tool,
          input: summarizeToolInput(tool, input, cwd),
          error: truncate(redactSecrets(String(payload.error ?? '')), 600),
          interrupted,
          test: out.isTestCommand,
          durationMs: payload.duration_ms ?? null,
        },
        quiet: !out.isTestCommand,
      });
      out.activity = { state: 'thinking', detail: null };
      break;
    }
    case 'PermissionRequest':
      out.events.push({
        type: 'agent.permission_requested',
        summary: `${who} needs approval: ${describeTool(tool, input, cwd)}`,
        data: { tool, input: summarizeToolInput(tool, input, cwd) },
      });
      out.activity = { state: 'needs_approval', detail: describeTool(tool, input, cwd) };
      break;
    case 'PermissionDenied':
      out.events.push({
        type: 'agent.permission_decided',
        summary: `${who} was denied: ${describeTool(tool, input, cwd)}`,
        data: { tool, decision: 'deny', input: summarizeToolInput(tool, input, cwd) },
      });
      out.activity = { state: 'thinking', detail: null };
      break;
    case 'Notification': {
      const type = String(payload.notification_type ?? '');
      const message = truncate(redactSecrets(String(payload.message ?? '')), 300);
      out.events.push({ type: 'agent.notification', summary: `${who}: ${message || type || 'notification'}`, data: { notificationType: type, message }, quiet: type === 'idle_prompt' });
      if (type === 'permission_prompt') out.activity = { state: 'needs_approval', detail: message || 'Waiting at a permission prompt in the terminal' };
      else if (type === 'idle_prompt') out.activity = { state: 'waiting_input', detail: null };
      else if (type === 'elicitation_dialog' || type === 'agent_needs_input') out.activity = { state: 'waiting_answer', detail: message || null };
      break;
    }
    case 'Stop':
      out.turnFinished = true;
      out.events.push({
        type: 'agent.turn_finished',
        summary: `${who} finished a turn`,
        data: { lastMessage: truncate(redactSecrets(String(payload.last_assistant_message ?? '')), 6000), stopHookActive: payload.stop_hook_active === true },
        quiet: true,
      });
      // The orchestrator decides between idle / waiting based on task state.
      break;
    case 'StopFailure':
      out.turnFinished = true;
      out.events.push({
        type: 'agent.tool_failed',
        summary: `${who}'s turn ended with an error`,
        data: { error: truncate(redactSecrets(String(payload.error ?? payload.message ?? '')), 600), stopFailure: true },
      });
      out.activity = { state: 'blocked', detail: 'Turn ended with an API/runtime error' };
      break;
    case 'SubagentStart':
      out.events.push({ type: 'agent.subagent_started', summary: `${who} started a subagent${payload.agent_type ? ` (${payload.agent_type})` : ''}`, data: { agentType: payload.agent_type ?? null, agentId: payload.agent_id ?? null }, quiet: true });
      out.activity = { state: 'delegating', detail: payload.agent_type ? `Subagent: ${payload.agent_type}` : 'Working with a subagent' };
      break;
    case 'SubagentStop':
      out.events.push({ type: 'agent.subagent_finished', summary: `${who}'s subagent finished`, data: { agentType: payload.agent_type ?? null, agentId: payload.agent_id ?? null }, quiet: true });
      break;
    // Claude Code's own task list (its TaskCreate/TaskUpdate tools, and agent teams): steps inside a turn,
    // not Orchestrator tasks — those are only ever completed through verification.
    case 'TaskCreated':
      out.events.push({ type: 'agent.step_planned', summary: `${who} planned a step: ${step(payload)}`, data: { stepId: payload.task_id ?? null, subject: step(payload), teammate: payload.teammate_name ?? null }, quiet: true });
      break;
    case 'TaskCompleted':
      out.events.push({ type: 'agent.step_completed', summary: `${who} finished a step: ${step(payload)}`, data: { stepId: payload.task_id ?? null, subject: step(payload), teammate: payload.teammate_name ?? null } });
      break;
    case 'TeammateIdle':
      out.events.push({ type: 'agent.teammate_idle', summary: `${who}'s teammate ${truncate(String(payload.teammate_name ?? ''), 60) || '(unnamed)'} is idle`, data: { teammate: payload.teammate_name ?? null }, quiet: true });
      break;
    default:
      break;
  }
  return out;
}
