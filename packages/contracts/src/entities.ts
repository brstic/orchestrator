/**
 * Core domain entities.
 *
 * The distinction between Employee (persistent virtual identity), AgentSession
 * (a real running Claude Code process inside tmux), Host (the machine running
 * it) and Task (the work) is deliberate and load-bearing: an employee outlives
 * any one session.
 */

export type ID = string;
export type ISODate = string;

// ───────────────────────────── Hosts ─────────────────────────────

export type HostStatus = 'online' | 'offline' | 'revoked';

export interface HostInfo {
  hostname: string;
  platform: string;
  arch: string;
  agentVersion: string;
  tmuxVersion: string | null;
  claudeVersion: string | null;
  cpus: number;
  totalMemBytes: number;
  user: string;
  /** Worker runtimes this host can actually provide (capability detection). */
  runtimes?: ExecutionMode[];
}

/** Every number here is measured on the host. Absent means "not available". */
export interface HostResources {
  ts: ISODate;
  cpuPercent: number | null;
  loadAvg1: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  sessionCount: number;
  processes: Array<{ sessionId: ID; pid: number | null; alive: boolean; command: string | null }>;
}

export interface Host {
  id: ID;
  name: string;
  status: HostStatus;
  info: HostInfo | null;
  resources: HostResources | null;
  enrolledAt: ISODate;
  lastSeenAt: ISODate | null;
  revokedAt: ISODate | null;
  /** True for the machine the server itself runs on (local-only mode). */
  local: boolean;
  /**
   * A personal host: the computer of a member of the office, connected while they are in it. Everything on it
   * (employees, sessions, folders) is that member's, not shared. Null or absent: a shared machine.
   */
  memberId?: ID | null;
  /** That member's name, for the sign on their room. */
  memberName?: string | null;
}

// ─────────────────────────── Employees ───────────────────────────

/**
 * How much an employee may do without asking. `auto` hands permission decisions to Claude Code's
 * own auto mode (its safety classifier), so the owner is asked for decisions and direction only.
 */
export type AutonomyLevel = 'restricted' | 'supervised' | 'standard' | 'autonomous' | 'auto';

export type CommunicationStyle =
  | 'concise'
  | 'analytical'
  | 'cautious'
  | 'experimental'
  | 'detail-oriented'
  | 'architecture-focused'
  | 'highly-independent'
  | 'review-focused';

export type ExecutionMode = 'interactive_cli' | 'managed_sdk';

export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: 'short' | 'long' | 'bun' | 'bald' | 'curly';
  shirt: string;
  pants: string;
  accessory: 'none' | 'glasses' | 'headphones' | 'cap';
  build: number; // 0.9 – 1.1 body scale
}

export interface WorkSchedule {
  /** When false the scheduler never auto-starts work for this employee. */
  available: boolean;
  /** Optional local-time window, e.g. "09:00"–"18:00". Empty = always. */
  from?: string;
  to?: string;
}

export interface EmployeeStats {
  tasksCompleted: number;
  testsPassed: number;
  bugsFixed: number;
  reviewsCompleted: number;
  assists: number;
  deliverablesAccepted: number;
}

export interface Employee {
  id: ID;
  name: string;
  title: string;
  department: string;
  /** Key into the role catalogue, or "custom". */
  roleKey: string;
  specialization: string;
  skills: string[];
  appearance: Appearance;
  style: CommunicationStyle;
  hostId: ID | null;
  model: string | null;
  projectId: ID | null;
  /**
   * The Claude config folder (CLAUDE_CONFIG_DIR) their sessions use on their machine: a different folder is a
   * different Claude login. Null = the machine's default account.
   */
  claudeConfigDir?: string | null;
  /** Other projects this employee may also be given tasks from (their main project stays `projectId`). */
  alsoProjectIds?: ID[];
  workingDir: string | null;
  instructions: string;
  allowedTools: string[];
  disallowedTools: string[];
  autonomy: AutonomyLevel;
  executionMode: ExecutionMode;
  schedule: WorkSchedule;
  deskId: string | null;
  /** Virtual progression. Never implies the underlying model is more capable. */
  xp: number;
  level: number;
  badges: string[];
  stats: EmployeeStats;
  createdAt: ISODate;
  archived: boolean;
}

// ─────────────────────────── Sessions ────────────────────────────

/**
 * What the employee is really doing, derived only from real signals (hooks,
 * MCP reports, process state). `unknown` is used whenever we cannot tell —
 * e.g. an attached session with no hooks installed.
 */
export type ActivityState =
  | 'offline'
  | 'unknown'
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'coding'
  | 'testing'
  | 'debugging'
  | 'running_command'
  | 'researching'
  | 'planning'
  | 'reviewing'
  | 'delegating'
  | 'waiting_answer'
  | 'needs_approval'
  | 'blocked'
  | 'waiting_input'
  | 'task_complete'
  | 'meeting'
  | 'paused';

export type ControlState =
  | 'AGENT_CONTROLLED'
  | 'HUMAN_OBSERVING'
  | 'HUMAN_CONTROLLED'
  | 'PAUSED'
  | 'DISCONNECTED';

export type SessionStatus = 'starting' | 'running' | 'exited' | 'lost' | 'host_offline';

export type SessionOrigin = 'managed' | 'attached';

/** Capability detection: what this particular session genuinely supports. */
export interface SessionCapabilities {
  /** Live terminal stream + input through tmux. */
  terminal: boolean;
  /** Claude Code lifecycle hooks reach Orchestrator. */
  hooks: boolean;
  /** The Orchestrator MCP server is configured for this session. */
  mcp: boolean;
  /** Permission requests can be answered structurally (hook / SDK callback). */
  structuredApproval: boolean;
  /** Messages can be delivered without typing into the terminal. */
  structuredMessaging: boolean;
  /** Token usage can be measured (transcript available). */
  usage: boolean;
}

export interface SessionUsage {
  /** Summed from the Claude Code transcript on the host — measured, not estimated. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
  measuredAt: ISODate;
  /**
   * Running cost reported by the Claude Agent SDK for SDK-managed workers. The SDK itself calls
   * it an estimate, not a billing statement. Absent for interactive CLI workers, which expose no cost.
   */
  costUsdEstimate?: number | null;
}

export interface AgentSession {
  id: ID;
  /** The launch currently in force for a managed session; reports from the host about another launch are stale. */
  launchId?: string | null;
  employeeId: ID | null;
  hostId: ID;
  origin: SessionOrigin;
  mode: ExecutionMode;
  tmuxSession: string;
  tmuxPane: string | null;
  cwd: string;
  repoRoot: string | null;
  branch: string | null;
  claudeSessionId: string | null;
  status: SessionStatus;
  activity: ActivityState;
  /** Short human-readable detail, e.g. "Edit src/auth.ts". Sourced from hooks. */
  activityDetail: string | null;
  activitySince: ISODate;
  /**
   * Whether Claude is in the middle of a turn, derived from hooks
   * (UserPromptSubmit … Stop). false = between turns, safe to hand it a prompt;
   * null = unknown (no hooks). Separate from `activity`, which is for display.
   */
  inTurn: boolean | null;
  control: ControlState;
  controllerId: string | null;
  capabilities: SessionCapabilities;
  permissionMode: string | null;
  model: string | null;
  cols: number;
  rows: number;
  pid: number | null;
  usage: SessionUsage | null;
  startedAt: ISODate;
  endedAt: ISODate | null;
  lastEventAt: ISODate | null;
  exitReason: string | null;
}

// ─────────────────────────── Projects ────────────────────────────

export type ProjectStatus = 'active' | 'paused' | 'archived';

export interface ProjectPolicy {
  /** Extra Claude Code permission allow rules, e.g. "Bash(npm test:*)". */
  allow: string[];
  deny: string[];
  /** Regexes for shell commands that always require the owner's approval. */
  highRiskPatterns: string[];
  /** When true, READY tasks with a matching free employee start automatically. */
  autoAssign: boolean;
  /** Tasks need an approved review before they count as DONE. */
  requireReview: boolean;
  /** Merge verified work into the integration branch automatically. */
  autoMerge: boolean;
  /** After each merge, run the verification command on the integration branch itself (default: on). */
  integrationTests?: boolean;
}

/** What is known about a shared project's integration branch: its last test run and its last promotion to the base branch. */
export interface IntegrationRecord {
  lastTest: { ts: ISODate; sha: string | null; passed: boolean | null; command: string; outputTail: string; durationMs: number | null; after: string } | null;
  lastPromotion: { ts: ISODate; sha: string; commits: number; by: string } | null;
}

export interface Project {
  id: ID;
  name: string;
  description: string;
  goals: string;
  requirements: string;
  docs: string;
  hostId: ID | null;
  repoPath: string | null;
  baseBranch: string;
  integrationBranch: string;
  /**
   * worktrees — every employee gets an isolated git worktree and branch; work is merged into the
   *             integration branch (for projects several employees share).
   * in_place  — the employee works directly in the folder, on whatever branch is checked out
   *             (the "cubicle": one employee owns the project in the folder they live in).
   */
  workspace: 'worktrees' | 'in_place';
  /** For an in-place project: the employee who lives in this folder. */
  ownerEmployeeId: ID | null;
  /** Command executed on the host to verify completed work, e.g. "npm test". */
  verifyCommand: string | null;
  verifyTimeoutSec: number;
  /** Further repositories of this project on the same machine: sessions get them as additional working directories. */
  extraRepos?: Array<{ name: string; path: string }>;
  /** Projects this one builds on (shown to the owner and given to employees as context). */
  dependsOn?: ID[];
  /** Integration-branch test runs and promotions (shared projects only). */
  integration?: IntegrationRecord;
  color: string;
  status: ProjectStatus;
  policy: ProjectPolicy;
  milestones: Array<{ id: ID; title: string; done: boolean; doneAt: ISODate | null }>;
  /** Set once every released task of the project has been verified DONE. */
  deliveredAt: ISODate | null;
  createdAt: ISODate;
}

// ───────────────────────────── Tasks ─────────────────────────────

export type TaskStatus = 'BACKLOG' | 'READY' | 'IN_PROGRESS' | 'REVIEW' | 'DONE' | 'BLOCKED';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskKind = 'feature' | 'bug' | 'test' | 'review' | 'research' | 'planning' | 'security' | 'docs' | 'ops' | 'refactor' | 'chore';

export type EvidenceProvenance = 'measured' | 'reported' | 'unavailable';

export interface VerificationResult {
  ts: ISODate;
  command: string | null;
  exitCode: number | null;
  passed: boolean | null;
  outputTail: string;
  durationMs: number | null;
  provenance: EvidenceProvenance;
}

export interface TaskEvidence {
  /** The agent's own completion report (provenance: reported). */
  summary: string | null;
  reportedTests: string | null;
  /** Measured on the host by Orchestrator, independent of the agent's claims. */
  commits: Array<{ sha: string; subject: string; author: string; ts: string }>;
  filesChanged: string[];
  diffStat: string | null;
  verification: VerificationResult | null;
  review: { reviewerId: ID | null; verdict: 'approved' | 'changes_requested'; comments: string; ts: ISODate; by: 'employee' | 'owner' } | null;
  merge: { ts: ISODate; ok: boolean; sha: string | null; into: string; detail: string } | null;
}

export interface TaskHistoryEntry {
  ts: ISODate;
  status: TaskStatus;
  note: string;
  by: string;
}

export interface Task {
  id: ID;
  /** Short human key, e.g. "T-12". */
  key: string;
  projectId: ID;
  title: string;
  description: string;
  acceptance: string;
  kind: TaskKind;
  priority: TaskPriority;
  status: TaskStatus;
  assigneeId: ID | null;
  /** Preferred role when unassigned (used by the scheduler). */
  roleHint: string | null;
  dependsOn: ID[];
  branch: string | null;
  worktree: string | null;
  baseSha: string | null;
  /**
   * In-place projects only: paths that already had uncommitted changes in the owner's folder
   * when the task started. They are the owner's, so they never block completion and the
   * employee is told to leave them alone.
   */
  baseDirty?: string[] | null;
  requiresReview: boolean;
  reviewerId: ID | null;
  /** For kind=review: the task under review. */
  reviewOf: ID | null;
  verifyCommand: string | null;
  /**
   * Released tasks are scheduled as soon as their dependencies are done.
   * Unreleased tasks (e.g. proposed by an agent) wait for the owner's go-ahead.
   */
  released: boolean;
  /** How many times Orchestrator nudged the agent to continue this task. */
  nudges: number;
  /** Counted problems on the way to done. Input for retrospectives and learned routing. */
  friction: { failedVerifications: number; reviewRejections: number; mergeConflicts: number; blockers: number; questions: number; denials: number };
  blockedReason: string | null;
  progress: { percent: number | null; note: string | null; ts: ISODate | null };
  evidence: TaskEvidence;
  history: TaskHistoryEntry[];
  attempts: number;
  createdBy: string;
  createdAt: ISODate;
  updatedAt: ISODate;
  startedAt: ISODate | null;
  completedAt: ISODate | null;
  /** Delivery of the task prompt to the session: confirmed only by a real hook. */
  delivery: DeliveryState;
}

// ───────────────────── Questions / approvals ─────────────────────

export type QuestionKind = 'question' | 'decision' | 'permission' | 'priority' | 'merge_conflict' | 'deployment' | 'trust_prompt';

/**
 * open        → waiting for the owner
 * answered    → owner replied; delivery in flight
 * delivered   → handed to the runtime (hook stdout written / tool result returned / keys sent)
 * confirmed   → the runtime acknowledged (tool result consumed, matching hook observed)
 * failed      → could not be delivered
 * superseded  → resolved elsewhere (e.g. answered directly in the terminal) or timed out
 */
export type QuestionStatus = 'open' | 'answered' | 'delivered' | 'confirmed' | 'failed' | 'superseded';

/** How a question reached us, which also determines how the answer travels back. */
export type QuestionChannel = 'mcp_tool' | 'permission_hook' | 'ask_user_question_hook' | 'terminal' | 'system';

export interface QuestionOption {
  label: string;
  description?: string;
  consequence?: string;
}

export interface Question {
  id: ID;
  kind: QuestionKind;
  channel: QuestionChannel;
  employeeId: ID | null;
  sessionId: ID | null;
  taskId: ID | null;
  projectId: ID | null;
  text: string;
  context: string;
  why: string;
  options: QuestionOption[];
  /** For permission requests: the real tool and input Claude wants to run. */
  tool: { name: string; input: unknown } | null;
  /** For multi-part questions (Claude Code's AskUserQuestion): every part needs an answer. */
  parts: Array<{ question: string; header: string | null; options: QuestionOption[]; multiSelect: boolean }>;
  answers: Record<string, string> | null;
  status: QuestionStatus;
  answer: string | null;
  decision: 'allow' | 'deny' | null;
  /** Who answered, when it was not the owner's own reply: a foreman answering on the owner's behalf. */
  answeredBy?: { kind: 'owner' | 'foreman'; id: ID | null; name: string } | null;
  createdAt: ISODate;
  answeredAt: ISODate | null;
  deliveredAt: ISODate | null;
  confirmedAt: ISODate | null;
  deliveryDetail: string | null;
}

// ─────────────────────────── Messaging ───────────────────────────

/**
 * queued → sent (written to the runtime) → confirmed (runtime acknowledged it,
 * e.g. a UserPromptSubmit hook carrying our correlation marker).
 */
export type DeliveryStatus = 'none' | 'queued' | 'sent' | 'confirmed' | 'failed';

export interface DeliveryState {
  status: DeliveryStatus;
  via: 'terminal_paste' | 'stop_hook' | 'mcp_pull' | 'sdk' | null;
  ts: ISODate | null;
  detail: string | null;
}

export type MessageKind = 'chat' | 'collab_request' | 'handoff' | 'review_request' | 'review_feedback' | 'task' | 'answer' | 'meeting' | 'system' | 'report_request';

export interface Message {
  id: ID;
  kind: MessageKind;
  from: { kind: 'owner' | 'employee' | 'system'; id: ID | null; name: string };
  toEmployeeId: ID;
  body: string;
  taskId: ID | null;
  /** Collaboration request this message belongs to. */
  threadId: ID | null;
  delivery: DeliveryState;
  createdAt: ISODate;
  readAt: ISODate | null;
}

export type CollabStatus = 'open' | 'incorporated' | 'new_task' | 'needs_decision' | 'dependency' | 'declined' | 'resolved';

export interface CollabRequest {
  id: ID;
  fromEmployeeId: ID;
  toEmployeeId: ID;
  projectId: ID | null;
  taskId: ID | null;
  summary: string;
  detail: string;
  status: CollabStatus;
  response: string | null;
  /** The responder's task at the time they agreed to help (assist XP is tied to its verified completion). */
  responderTaskId: ID | null;
  createdAt: ISODate;
  resolvedAt: ISODate | null;
}

// ───────────────────────── Notifications ─────────────────────────

export type NotificationKind =
  | 'question'
  | 'permission'
  | 'test_failure'
  | 'task_completed'
  | 'security'
  | 'blocked'
  | 'host_disconnected'
  | 'host_resources'
  | 'session_lost'
  | 'merge_conflict'
  | 'review'
  | 'milestone'
  | 'improvement'
  | 'info';

export interface Notification {
  id: ID;
  kind: NotificationKind;
  severity: 'info' | 'success' | 'warning' | 'critical';
  title: string;
  body: string;
  employeeId: ID | null;
  sessionId: ID | null;
  taskId: ID | null;
  projectId: ID | null;
  questionId: ID | null;
  hostId: ID | null;
  createdAt: ISODate;
  readAt: ISODate | null;
  resolvedAt: ISODate | null;
}

// ──────────────────────────── Meetings ───────────────────────────

export type MeetingStatus = 'scheduled' | 'proposals' | 'responses' | 'synthesis' | 'concluded' | 'cancelled';

export interface MeetingContribution {
  id: ID;
  employeeId: ID;
  round: 'proposal' | 'response' | 'synthesis';
  body: string;
  disagreements: string[];
  ts: ISODate;
}

export interface Meeting {
  id: ID;
  projectId: ID | null;
  topic: string;
  context: string;
  status: MeetingStatus;
  facilitatorId: ID;
  participantIds: ID[];
  /** Participants who did not answer a round in time. Recorded, never invented. */
  absent: ID[];
  contributions: MeetingContribution[];
  decisionDoc: string | null;
  generatedTaskIds: ID[];
  createdAt: ISODate;
  roundStartedAt: ISODate | null;
  concludedAt: ISODate | null;
}

export interface Artifact {
  id: ID;
  kind: 'decision_doc' | 'report' | 'plan' | 'review' | 'test_output' | 'summary';
  title: string;
  content: string;
  projectId: ID | null;
  taskId: ID | null;
  meetingId: ID | null;
  employeeId: ID | null;
  createdAt: ISODate;
}

// ────────────────────────── Progression ──────────────────────────

export type XpReason = 'task_completed' | 'tests_passed' | 'bug_fixed' | 'review_completed' | 'deliverable_accepted' | 'assist';

export interface XpEntry {
  id: ID;
  employeeId: ID;
  amount: number;
  reason: XpReason;
  /** The verified record that justifies this XP (task id, review id…). */
  evidenceRef: string;
  note: string;
  ts: ISODate;
}

export interface CompanyStats {
  projectsDelivered: number;
  tasksCompleted: number;
  bugsResolved: number;
  testsPassed: number;
  verificationsRun: number;
  reviewsCompleted: number;
  reviewCompletionRate: number | null;
  mergesSucceeded: number;
  mergeConflicts: number;
  questionsAnswered: number;
  /** Reviews that were asked for; with `reviewsCompleted` this gives the completion rate. */
  reviewsRequested: number;
  /** Release commands that really succeeded in a worker's terminal (publish, release, tag, image push). */
  releases: number;
  /** Deployment commands seen in workers' terminals, and how many of them failed. */
  deployments: number;
  deploymentsFailed: number;
  /** Verified refactoring and chore tasks: technical debt that was actually paid down. */
  debtReduced: number;
  /** Time workers spent in progress on tasks that then passed verification (ms): work the owner did not do by hand. */
  agentWorkMs: number;
  /** Sessions started, sessions that were lost unexpectedly, and host disconnections: the basis of the reliability figure. */
  sessionsStarted: number;
  sessionsLost: number;
  hostDisconnects: number;
  /** Share of started sessions that were not lost (0–1), or null before any session ran. */
  infrastructureReliability: number | null;
}

export interface Milestone {
  key: string;
  title: string;
  description: string;
  unlockedAt: ISODate | null;
  /** Office upgrade granted by this milestone, if any. */
  unlocks: string | null;
}

// ──────────────────────── Self-improvement ───────────────────────

export interface EvidenceRef {
  kind: 'task' | 'question' | 'review' | 'event' | 'meeting' | 'approval';
  id: ID;
  note: string;
}

export type LessonSource = 'retrospective' | 'owner_answer' | 'owner' | 'meeting' | 'orchestrator';

/**
 * Something learned from real work, kept and fed back into future prompts.
 * Employee-scoped lessons form that employee's playbook; project and company
 * lessons are shared knowledge. Every lesson cites the records it came from.
 */
export interface Lesson {
  id: ID;
  scope: 'employee' | 'project' | 'company';
  employeeId: ID | null;
  projectId: ID | null;
  /** The reusable rule, phrased as an instruction. */
  text: string;
  /** When it applies, e.g. "when changing an API contract". */
  appliesWhen: string;
  source: LessonSource;
  evidence: EvidenceRef[];
  /** proposed = waiting for the owner; active = included in prompts; retired = kept for the record only. */
  status: 'proposed' | 'active' | 'retired';
  authoredBy: { kind: 'employee' | 'owner' | 'orchestrator'; id: ID | null; name: string };
  /** How many prompts this lesson has been included in. */
  appliedCount: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** Measured outcome for an employee on one kind of task. Counts, never estimates. */
export interface PerformanceStat {
  employeeId: ID;
  kind: TaskKind;
  completed: number;
  /** Completed with no failed verification and no review rejection. */
  firstPass: number;
  failedVerifications: number;
  reviewRejections: number;
  mergeConflicts: number;
}

export type ImprovementKind = 'allow_rule' | 'deny_rule' | 'autonomy' | 'review_policy' | 'verify_command' | 'verify_timeout' | 'sequencing' | 'acceptance_criteria' | 'routing';

export type ImprovementAction =
  | { type: 'project.policy.allow'; projectId: ID; rule: string }
  | { type: 'project.policy.deny'; projectId: ID; rule: string }
  | { type: 'project.requireReview'; projectId: ID; value: boolean }
  | { type: 'project.verifyTimeout'; projectId: ID; seconds: number }
  | { type: 'employee.autonomy'; employeeId: ID; level: AutonomyLevel }
  | { type: 'advice' };

/**
 * A change Orchestrator proposes to its own way of working, derived from its
 * recorded history. Anything that widens what agents may do without asking is
 * never applied without the owner.
 */
export interface Improvement {
  id: ID;
  kind: ImprovementKind;
  title: string;
  rationale: string;
  evidence: EvidenceRef[];
  projectId: ID | null;
  employeeId: ID | null;
  action: ImprovementAction;
  status: 'proposed' | 'applied' | 'dismissed';
  /** Stable key so the same finding is not proposed twice. */
  dedupeKey: string;
  createdAt: ISODate;
  decidedAt: ISODate | null;
}

export interface SelfImprovementSettings {
  enabled: boolean;
  /** When workers are asked to reflect: after tasks that hit friction, after every task, or never. */
  retrospectives: 'off' | 'friction' | 'always';
  /** Lessons employees propose for the whole project/company become active without owner review. */
  autoApproveSharedLessons: boolean;
  /** Let measured outcomes influence which employee the scheduler picks. */
  learnedRouting: boolean;
}

// ──────────────────────────── Foreman ────────────────────────────

/**
 * Rounds of the foreman (an employee with the `foreman` role). A round is one prompt delivered to the
 * foreman's own Claude Code session, so each one uses that account's Claude usage; the office decides
 * when one is due without any model.
 */
export interface ForemanSettings {
  /** Off by default: nothing is ever delivered to a foreman unless the owner switches this on. */
  enabled: boolean;
  /** The shortest time between the end of one round and the start of the next. */
  minGapSeconds: number;
  /** With nothing waiting, one look around at most this often, and only if the office changed. 0 = never. */
  quietCheckMinutes: number;
  /** Employees' questions go to the foreman first. Permission requests never do. */
  answersQuestions: boolean;
}

export type ForemanAttentionKind = 'question' | 'blocked' | 'stalled' | 'unassigned';

/** One thing that calls for the foreman, computed from recorded state. */
export interface ForemanAttentionItem {
  /** Stable while the thing stays as it is; a round is only started for keys the foreman has not seen. */
  key: string;
  kind: ForemanAttentionKind;
  text: string;
  employeeId: ID | null;
  taskId: ID | null;
  questionId: ID | null;
  projectId: ID | null;
  since: ISODate;
  /** Already put in front of the foreman in an earlier round. */
  seen: boolean;
  /** A question the foreman passed on to the owner. */
  escalated: boolean;
}

export interface ForemanRound {
  id: ID;
  reason: 'attention' | 'quiet_check';
  startedAt: ISODate;
  finishedAt: ISODate | null;
  /** finished = the foreman called finish_round; turn_ended = its turn ended without one. */
  outcome: 'running' | 'finished' | 'turn_ended' | 'timed_out' | 'failed' | 'interrupted';
  summary: string | null;
  /** New items the round was started for, by kind. */
  counts: Record<ForemanAttentionKind, number>;
  fresh: number;
  /** Items listed again that an earlier round had already shown. */
  stillOpen: number;
  /** Employees the foreman looked at during the round. */
  visited: ID[];
  actions: { answered: number; assigned: number; created: number; escalated: number; messaged: number };
}

export interface ForemanStatus {
  settings: ForemanSettings;
  /** The employee who does the rounds, if there is one. */
  foreman: { id: ID; name: string; session: SessionStatus | null; activity: ActivityState | null } | null;
  /** Further employees with the foreman role: they have the tools, but rounds go to one. */
  otherForemen: string[];
  /** A round could be handed over right now. */
  available: boolean;
  problem: string | null;
  round: ForemanRound | null;
  lastRound: ForemanRound | null;
  rounds: ForemanRound[];
  attention: ForemanAttentionItem[];
  /** The gap between rounds actually in force. */
  minGapSeconds: number;
  earliestNextRoundAt: ISODate | null;
}

// ───────────────────────── Office layout ─────────────────────────

export interface Desk {
  id: string;
  x: number;
  z: number;
  /** Rotation around Y in radians; the chair sits on the -Z side of the desk in local space. */
  rot: number;
  zone: string;
  kind: 'standard' | 'specialized' | 'executive';
}

export interface RoomDef {
  id: string;
  name: string;
  kind: 'ceo' | 'open' | 'meeting' | 'ops' | 'server' | 'break' | 'reception' | 'hall' | 'team';
  x: number;
  z: number;
  w: number;
  d: number;
  /** Requires a milestone unlock to appear. */
  requires?: string;
  /** Door openings: side of the room, position along that wall (0..1) and width in metres. */
  doors?: Array<{ side: 'n' | 's' | 'e' | 'w'; at: number; width: number }>;
  /** Walls rendered as glass partitions. */
  glass?: boolean;
  /** No walls at all (open-plan areas, halls). */
  open?: boolean;
}

export interface OfficeLayout {
  version: number;
  width: number;
  depth: number;
  rooms: RoomDef[];
  desks: Desk[];
  decorations: Array<{ id: string; kind: string; x: number; z: number; rot: number; requires?: string }>;
  /** What the owner wrote on a table (a desk pod), by pod id; shown on a small sign above it. */
  podLabels?: Record<string, string>;
}

/** An internet radio station for the office hi-fi: a direct audio stream the browser can play. */
export interface RadioStation {
  id: string;
  name: string;
  /** Direct stream URL (http/https), e.g. an Icecast/Shoutcast/AzuraCast mount ending in .mp3 or .aac. */
  url: string;
  /** Optional JSON endpoint that says what is on air (AzuraCast "nowplaying" format is understood). */
  nowPlayingUrl?: string | null;
  /** Optional public page of the station. */
  page?: string | null;
}

export interface RadioSettings {
  stations: RadioStation[];
  /** 0–1. */
  volume: number;
  /** The station that was last played; nothing starts by itself. */
  lastStationId: string | null;
}

/** One rate-limit window as Claude Code reports it for a subscription account. */
export interface LimitWindow {
  /** Percentage of the window used, 0–100. */
  usedPercent: number;
  /** When the window resets. */
  resetsAt: ISODate | null;
}

/**
 * How much of a Claude account's allowance is used, as Claude Code itself reported it in one of
 * the sessions running on that account. Several employees can share an account; different
 * employees can be on different accounts (a different machine, or a different Claude config folder).
 */
export interface AccountUsage {
  /** `<hostId>|<config folder or "default">`. */
  key: string;
  hostId: ID;
  /** The Claude config folder this account lives in on that machine; null = the machine's default login. */
  configDir: string | null;
  /** Who is logged in there, read from Claude Code's own config on that machine. */
  email: string | null;
  organization: string | null;
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  /** When these figures were reported, and by whose session. Null: no session on this account has reported yet. */
  reportedAt: ISODate | null;
  reportedBy: ID | null;
  /** Employees currently set up to use this account. */
  employeeIds: ID[];
}

/** The office TV: a web browser in the owner's own window. */
export interface TvSettings {
  /** Where it opens when switched on. */
  home: string;
  bookmarks: Array<{ name: string; url: string }>;
}

export interface OwnerSettings {
  /** The office TV. Browsing happens in the owner's own window; employees have nothing to do with it. */
  tv: TvSettings;
  /** The office hi-fi. Playback happens in the owner's own window; nothing is sent to employees. */
  radio: RadioSettings;
  companyName: string;
  ownerName: string;
  gamification: boolean;
  /** Let a headless Claude run interpret commands the rule-based parser cannot. Uses tokens. */
  nlFallback: boolean;
  selfImprovement: SelfImprovementSettings;
  /** The foreman's rounds (off by default). */
  foreman: ForemanSettings;
  /**
   * false (default): workers load only the Orchestrator MCP server. true: they also load the
   * owner's own MCP servers and connectors — more tools, more tokens per request, and autonomous
   * agents gain whatever those connectors can reach.
   */
  workersInheritMcp: boolean;
  /**
   * true (default): an employee on `auto` still needs the owner's approval for commands that match
   * the high-risk list (pushes, sudo, deploys, broad deletions, …). false: those go to Claude Code's
   * auto mode like everything else.
   */
  autoAsksHighRisk: boolean;
  /** Mark each project's desks on the floor (outline, sign and counts). Off unless the owner switches it on. */
  projectZones: boolean;
  /** Move the camera in closer when the owner stands at an employee's desk. Off unless the owner switches it on. */
  approachZoom: boolean;
  quality: 'low' | 'medium' | 'high';
  keybindings: Record<string, string>;
  lastSeenAt: ISODate | null;
}

export interface AuditEntry {
  id: ID;
  ts: ISODate;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
}
