import type { ID, ISODate } from './entities.ts';

/**
 * Stable, normalized Orchestrator event schema.
 *
 * Every event shown in the office feed is one of these and is sourced from a
 * real signal: a Claude Code hook, an MCP tool call made by an agent, a tmux /
 * process observation on a host, or an explicit owner action. Purely visual
 * events are never stored here.
 */
export type EventType =
  | 'worker.connected'
  | 'worker.disconnected'
  | 'host.enrolled'
  | 'host.revoked'
  | 'host.shared'
  | 'host.unshared'
  | 'host.resource_update'
  | 'host.resource_warning'
  | 'session.started'
  | 'session.resumed'
  | 'session.stopped'
  | 'session.attached'
  | 'session.lost'
  | 'session.asleep'
  | 'session.woken'
  | 'session.activity'
  | 'terminal.output'
  | 'terminal.control_acquired'
  | 'terminal.control_released'
  | 'terminal.interrupt'
  | 'terminal.input_blocked'
  | 'terminal.resubmitted'
  | 'task.created'
  | 'task.assigned'
  | 'task.delivered'
  | 'task.started'
  | 'task.progress'
  | 'task.blocked'
  | 'task.unblocked'
  | 'task.verifying'
  | 'task.verification_failed'
  | 'task.review_requested'
  | 'task.review_completed'
  | 'task.merged'
  | 'task.merge_conflict'
  | 'task.completed'
  | 'task.updated'
  | 'task.handoff'
  | 'agent.prompt_submitted'
  | 'agent.tool_started'
  | 'agent.tool_finished'
  | 'agent.tool_failed'
  | 'agent.turn_finished'
  | 'agent.subagent_started'
  | 'agent.subagent_finished'
  | 'agent.step_planned'
  | 'agent.step_completed'
  | 'agent.teammate_idle'
  | 'agent.notification'
  | 'agent.question'
  | 'agent.question_answered'
  | 'agent.question_delivered'
  | 'agent.permission_requested'
  | 'agent.permission_decided'
  | 'agent.message'
  | 'agent.message_delivered'
  | 'agent.status_report'
  | 'agent.collaboration_requested'
  | 'agent.collaboration_resolved'
  // An employee began waiting for a colleague's answer or task, or stopped: data { phase: 'began' | 'ended', … }.
  | 'agent.waiting'
  | 'agent.result_submitted'
  | 'meeting.created'
  | 'meeting.round_started'
  | 'meeting.contribution'
  | 'meeting.concluded'
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'account.switched'
  | 'task.attachment_added'
  | 'task.stopped'
  | 'task.corrected'
  | 'task.commented'
  | 'task.reopened'
  | 'task.split'
  | 'session.cut_off'
  | 'employee.deleted'
  | 'vault.stored'
  | 'vault.used'
  | 'vault.removed'
  | 'project.integration_tested'
  | 'project.integration_synced'
  | 'project.promoted'
  | 'employee.created'
  | 'employee.updated'
  | 'progression.xp_awarded'
  | 'progression.level_up'
  | 'progression.milestone'
  | 'improvement.lesson_recorded'
  | 'improvement.lesson_updated'
  | 'improvement.retrospective_requested'
  | 'improvement.proposed'
  | 'improvement.applied'
  | 'improvement.dismissed'
  | 'foreman.round.started'
  | 'foreman.round.finished'
  | 'foreman.visit'
  /** A member's team lead is with one of its team: it looked at them, told them something or gave them work. */
  | 'lead.visit'
  | 'foreman.escalated'
  | 'routine.created'
  | 'routine.updated'
  | 'routine.removed'
  | 'routine.skipped'
  | 'ops.deployment'
  | 'security.alert'
  | 'owner.command'
  // What the office changed or chose by itself while learning: `learning.<verb>`, with data { auto, area, what, why, evidence, undo }.
  | `learning.${string}`;

export type EventSourceKind = 'hook' | 'mcp' | 'host' | 'server' | 'owner' | 'sdk';

export interface OrchestratorEvent {
  /** Globally unique; used for idempotent processing of redelivered events. */
  id: ID;
  /** Monotonic order assigned by the server's event store. */
  seq: number;
  ts: ISODate;
  type: EventType;
  source: { kind: EventSourceKind; hostId?: ID | null; detail?: string };
  correlationId: string | null;
  hostId: ID | null;
  sessionId: ID | null;
  employeeId: ID | null;
  taskId: ID | null;
  projectId: ID | null;
  /** One-line human readable description for the office feed. */
  summary: string;
  data: Record<string, unknown>;
}

export type NewEvent = Omit<OrchestratorEvent, 'seq' | 'id' | 'ts'> & { id?: ID; ts?: ISODate };

/**
 * A raw Claude Code hook invocation as forwarded by a host agent. `payload` is
 * exactly the JSON Claude Code wrote to the hook's stdin.
 */
export interface RawHookEvent {
  /** Unique per invocation, assigned by the host agent (dedupe key). */
  id: ID;
  ts: ISODate;
  /** Monotonic per-host ordering counter. */
  hostSeq: number;
  sessionId: ID | null;
  tmuxPane: string | null;
  payload: HookPayload;
}

export interface HookPayload {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  tool_use_id?: string;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
  prompt?: string;
  message?: string;
  title?: string;
  notification_type?: string;
  source?: string;
  reason?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  permission_suggestions?: unknown;
  agent_type?: string;
  agent_id?: string;
  [k: string]: unknown;
}
