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
  /** The effort levels this machine's Claude Code accepts (`claude --effort …`), read from its own help text. Empty: it has no such option. Absent: an agent from before this was reported. */
  claudeEffortLevels?: string[];
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
   * More Claude accounts on this machine, besides its default login: the Claude config folders the owner added
   * (`~/.claude-2`, …). Each is a separate login with an allowance of its own; employees are spread over them and
   * moved off one that has run out.
   */
  claudeAccounts?: string[];
  /**
   * A personal host: the computer of a member of the office, connected while they are in it. Everything on it
   * (employees, sessions, folders) is that member's, not shared. Null or absent: a shared machine.
   */
  memberId?: ID | null;
  /** That member's name, for the sign on their room. */
  memberName?: string | null;
  /** How the member wants their room: its size, colour, name and furniture. Null: as it comes. */
  room?: MemberRoomPrefs | null;
  /**
   * A server a member brought into the office themselves (over SSH, with their own keys): whose it is. It stays
   * theirs to share, take back or remove whatever `memberId` says: while it is private `memberId` is the same member;
   * once they share it `memberId` is null — the server is then a shared machine like the office's own — and this
   * is what remembers the owner. Absent on a member's own computer and on the office's machines.
   */
  ownerId?: ID | null;
  ownerName?: string | null;
}

/** A member's own choices for their room in the office. Everything is optional; the room is never smaller than its employees need. */
export interface MemberRoomPrefs {
  /** What the sign says instead of "<NAME>'S ROOM". */
  title?: string | null;
  /** Carpet and accent colour, `#rrggbb`. */
  color?: string | null;
  /** At least this many desks (in pairs), even when fewer employees live there. */
  desks?: number | null;
  /** Metres of open floor behind the desks: room to walk, and where the furniture stands. */
  extraDepth?: number | null;
  /** What stands in the room. */
  furniture?: MemberRoomFurniture[] | null;
  /**
   * The member closed their room: what is on their own computers and servers is theirs alone — nobody else, the
   * owners of the office and the foreman included, looks into it or directs it, and nobody else walks in. Others
   * still see that the employees are there and what state they are in.
   */
  locked?: boolean | null;
}
/** The id of a seat in a member's room: `m:<host id>:<n>`, n from 1. (The room itself is drawn by each client; see office-3d/member-rooms.) */
export const memberSeatId = (hostId: ID, n: number): string => `m:${hostId}:${n}`;
/** Which seat of which member computer a desk id names, or null when it is a desk of the shared office. */
export function memberSeatOf(deskId: string | null | undefined): { hostId: ID; n: number } | null {
  const m = /^m:([^:]+):(\d{1,2})$/.exec(deskId ?? '');
  const n = m ? Number(m[2]) : 0;
  return m && n >= 1 && n <= 20 ? { hostId: m[1]!, n } : null;
}
export type MemberRoomFurniture = 'plant' | 'bookshelf' | 'sofa' | 'floor_lamp';
export const MEMBER_ROOM_FURNITURE: MemberRoomFurniture[] = ['plant', 'bookshelf', 'sofa', 'floor_lamp'];
export const MEMBER_ROOM_LIMITS = { desks: 20, extraDepth: 12 } as const;

/** Keep what is a valid choice and drop the rest (what a member sends is drawn in everyone's office). */
export function sanitizeMemberRoom(input: unknown): MemberRoomPrefs {
  const p = (input ?? {}) as Record<string, unknown>;
  const out: MemberRoomPrefs = {};
  const title = typeof p.title === 'string' ? p.title.replace(/[\u0000-\u001f\s]+/g, ' ').trim().slice(0, 28).trim() : '';
  if (title) out.title = title;
  if (typeof p.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.color)) out.color = p.color.toLowerCase();
  const desks = Number(p.desks);
  if (Number.isFinite(desks) && desks >= 2) out.desks = Math.min(MEMBER_ROOM_LIMITS.desks, Math.ceil(desks / 2) * 2);
  const extra = Number(p.extraDepth);
  if (Number.isFinite(extra) && extra > 0) out.extraDepth = Math.min(MEMBER_ROOM_LIMITS.extraDepth, Math.round(extra * 2) / 2);
  if (Array.isArray(p.furniture)) out.furniture = MEMBER_ROOM_FURNITURE.filter((k) => (p.furniture as unknown[]).includes(k));
  if (p.locked === true) out.locked = true;
  return out;
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

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  /** The model their sessions run on: an alias Claude Code keeps current (`fable`, `opus`, `sonnet`, `haiku`) or a model's full name. Null: whatever the account's Claude Code uses by default. */
  model: string | null;
  /** How hard the model works on each turn (`claude --effort`). Null or absent: Claude Code's own default. */
  effort?: EffortLevel | null;
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
  /**
   * A person's own session: someone sat down at a desk and opened Claude Code for themselves. They type into it;
   * the office gives it no work of its own accord and does not nudge it.
   */
  selfDriven?: boolean;
  /** capture: projects whose "what this team has learned" digest this employee was already given (once, with their first task there). */
  captureOnboarded?: ID[];
  /** capture: what their finished work shows, counted from task records and hook events. `skills` above is what was declared at hiring. */
  captureSkills?: MeasuredSkill[];
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
  /** The effort this session was started with (null: Claude Code's default). */
  effort?: string | null;
  cols: number;
  rows: number;
  pid: number | null;
  usage: SessionUsage | null;
  startedAt: ISODate;
  endedAt: ISODate | null;
  lastEventAt: ISODate | null;
  exitReason: string | null;
  /**
   * Set when the office itself stopped this session because it sat idle (see `OwnerSettings.sleepAfterMinutes`):
   * the conversation is kept and anything that needs the employee starts it again. Cleared when it is started.
   */
  asleepSince?: ISODate | null;
  /** Whether the launch now in force continued an earlier conversation (false: it began a new one). */
  resumed?: boolean;
  /** What this session is waiting for from a colleague, if anything (see `SessionWait`). */
  waitingOn?: SessionWait | null;
}

/**
 * An employee asked a colleague for something and said they need it before they can go on (`request_collaboration`
 * or `request_help` with `wait`), or is waiting for a task to be finished (`wait_for_colleague`). Kept on the
 * waiting session's record, so it is in everyone's state and survives a restart of the office.
 */
export interface SessionWait {
  /** The colleague whose answer or work is awaited; null when nobody has it right now (a task that waits for the owner's review). */
  employeeId: ID | null;
  /** The request whose answer is awaited (`CollabRequest.id`), or null. */
  requestId: ID | null;
  /** The task whose end is awaited, or null. */
  taskId: ID | null;
  since: ISODate;
  /**
   * true: a tool call of the session is being held open for it right now. false: that call returned "not yet"
   * (or the office restarted); the wait stands, and the outcome reaches the session as a message.
   */
  held: boolean;
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
  /**
   * true: one employee at a time changes a folder that several work in (the next task for it waits its turn).
   * Default (absent/false): they work in it at the same time; each task counts only its own uncommitted files.
   */
  oneAtATime?: boolean;
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
  /** Routing preferences accepted from the record (learning/detect.ts): for a kind of task, the employee to prefer when free. */
  detectRouting?: Partial<Record<TaskKind, ID>>;
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
  /**
   * Files this task changed that are part of what it is checked by: tests, the test runner's settings, the script the
   * verification command runs. A check that passes after the task edited the check proves less; such work is reviewed.
   */
  touchedChecks?: string[];
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
  /** The root of the git repository the task's folder is in (the folder itself may be a subfolder of it). Absent: not a repository, or a task from before this was recorded. */
  repoRoot?: string | null;
  /**
   * Colleagues worked in the same folder (or the same repository) while this task was in progress: their names. From then
   * on only the files this task's own session wrote count as its uncommitted work.
   */
  sharedWith?: string[];
  /** Files this task's session wrote or edited (relative to `repoRoot`), as its hooks reported them. Kept only while the folder is shared. */
  touched?: string[];
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
  /**
   * The playbook lessons included in this task's prompts (every delivery of it, in the order first given).
   * Why each was chosen is in the task's `learning.lessons_delivered` events. Absent on tasks from before this existed.
   */
  playbookLessonIds?: ID[];
  /**
   * What the task is about, as whoever proposed it named it (a ticket's id, a URL). A proposal that carries the key of
   * a task this project already has adds nothing: a check that repeats every few minutes must not add the same item twice.
   */
  dedupeKey?: string | null;
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
  /**
   * capture: an already answered question of the same project that reads like this one (a word-overlap match,
   * not an understanding of the question). Shown to whoever answers; nothing is answered automatically.
   */
  captureAnsweredBefore?: { questionId: ID; text: string; answer: string; answeredAt: ISODate | null; askedBy: string | null; answeredBy: string; lessonId: ID | null; similarity: number } | null;
  /** autopilot: who decided a permission request, as the audit log names them ('owner', 'member:<name>'). Absent on older records. */
  autopilotDecidedBy?: string | null;
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
  /** Set when the office sent this as one run of a routine (see `Routine`). */
  routineId?: ID | null;
}

// ───────────────────────────── Routines ──────────────────────────

export type RoutineOutcome = 'delivered' | 'skipped_busy' | 'skipped_offline' | 'not_run' | 'failed';

/**
 * A standing instruction for one employee that the office repeats: "check the support desk every five minutes".
 * Each run is delivered into the employee's real session like a message from the owner, when they are between
 * turns; a run that finds them busy is skipped, never queued behind the one before.
 */
export interface Routine {
  id: ID;
  employeeId: ID;
  instruction: string;
  /** Minutes between two runs: a whole number, 1 to 1440. */
  everyMinutes: number;
  enabled: boolean;
  createdAt: ISODate;
  /** Who set it up ("owner", "member:Mila"). */
  createdBy: string;
  /** When it was last handed to the employee. */
  lastRunAt: ISODate | null;
  nextRunAt: ISODate | null;
  /** How many times it was handed to the employee. */
  runs: number;
  /** What the last look at it came to, when, and why in words. */
  lastOutcome: RoutineOutcome | null;
  lastOutcomeAt: ISODate | null;
  lastNote: string | null;
  /** The message of the last run, to see whether it has been delivered yet. */
  lastMessageId: ID | null;
}

export const ROUTINE_LIMITS = { minMinutes: 1, maxMinutes: 1440, defaultMinutes: 5, instruction: 2000, perEmployee: 10 };

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
  /** The task the request became, when the answer was "a separate task" (`new_task`). */
  createdTaskId?: ID | null;
  /** The one who asked said they cannot go on without the answer, and waits for it. */
  waited?: boolean;
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
  kind: 'task' | 'question' | 'review' | 'event' | 'meeting' | 'approval' | 'lesson' | 'message';
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
  /** Playbook bookkeeping (orchestration/src/learning/playbook.ts). Absent until the lesson is first used, merged or promoted. */
  playbook?: LessonPlaybookMeta;
  /** capture: why the rule exists — the evidence, in its author's words. */
  captureWhy?: string;
  /** capture: what the lesson was derived from, when nobody typed it in as a lesson. */
  captureOrigin?: CaptureOrigin;
  /**
   * capture: how many times this knowledge existed and its question was asked again anyway. Above zero means
   * "it did not reach the session that needed it": retrieval should put it in front of everything else.
   */
  captureMustInclude?: number;
  /** Outcomes: tasks given this lesson measurably went better than comparable tasks without it (docs/learning/outcomes.md). Retrieval may prefer these. */
  proven?: boolean;
  /**
   * Outcomes: set when the office retired this lesson by itself because the record showed it was not helping.
   * It stays on the lesson after someone re-activates it, and such a lesson is never retired automatically again.
   */
  outcomesRetired?: { at: ISODate; verdict: 'harmful' | 'not_helping'; why: string } | null;
}

/**
 * What the playbook keeps about one lesson. All of it is counted from what the office did;
 * none of it says whether the lesson helped.
 */
export interface LessonPlaybookMeta {
  /** When it was last included in a task prompt. (How often it was included is `Lesson.appliedCount`.) */
  lastIncludedAt: ISODate | null;
  /** Task prompts it was included in where its words fitted that task (text relevance at or above the match threshold). */
  matchedCount: number;
  /** Task prompts in a row it was included in without fitting the task. At the stale limit it is ranked down, never retired. */
  unmatchedStreak: number;
  /** How many near-duplicates were folded into this lesson. */
  mergedCount: number;
  /** The last few lessons folded in: whose they were and what they said. */
  mergedFrom: Array<{ ts: ISODate; lessonId: ID | null; by: string; text: string; similarity: number }>;
  /** Set on a lesson that was folded into another one (it is then retired): the lesson that carries on. */
  mergedInto: ID | null;
  /** For a project lesson made by promotion: the employees' own lessons it came from. */
  promotedFrom: ID[];
  /** Lessons this one must not be merged with again: a merge of the two was undone. */
  distinctFrom: ID[];
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
  /**
   * Outcomes: the same record with recent work counting more — what learned routing reads.
   * `weight` is the effective number of tasks after decay (a task loses half its weight every 45 days);
   * `firstPassRate` and `meanFriction` are weighted the same way; `routingRate` is that first-pass rate
   * with one pass and one fail added, so a short record speaks more quietly than a long one.
   */
  outcomes?: { weight: number; firstPassRate: number; routingRate: number; meanFriction: number; lastCompletedAt: ISODate | null };
}

export type ImprovementKind =
  | 'allow_rule' | 'deny_rule' | 'autonomy' | 'review_policy' | 'verify_command' | 'verify_timeout' | 'sequencing' | 'acceptance_criteria' | 'routing' | 'playbook_contradiction' | 'revert_improvement'
  // Found by the detectors in orchestration/src/learning/detect.ts.
  | 'task_size' | 'dependencies' | 'missing_context' | 'stall' | 'verify_quality' | 'machine_load' | 'idle_capacity';

export type ImprovementAction =
  | { type: 'project.policy.allow'; projectId: ID; rule: string }
  | { type: 'project.policy.deny'; projectId: ID; rule: string }
  | { type: 'project.requireReview'; projectId: ID; value: boolean }
  | { type: 'project.verifyTimeout'; projectId: ID; seconds: number }
  | { type: 'employee.autonomy'; employeeId: ID; level: AutonomyLevel }
  | { type: 'advice' }
  // learning/detect.ts — none of these lets an agent do more without asking.
  /** `taskId` waits for `dependsOnTaskId`. Inverse: take that id out of the task's dependencies again. */
  | { type: 'task.dependsOn'; taskId: ID; dependsOnTaskId: ID }
  /** When free, `employeeId` is preferred for tasks of this kind in the project. Inverse: put back the earlier preference (or none). */
  | { type: 'project.routing'; projectId: ID; kind: TaskKind; employeeId: ID }
  /** Add `text` as a line of the project's documentation notes. Inverse: take the line out again. */
  | { type: 'project.notes.append'; projectId: ID; text: string };

/**
 * A change Orchestrator proposes to its own way of working, derived from its
 * recorded history. Whether the office may apply one by itself is decided by
 * the autopilot dial (`SelfImprovementSettings.autopilot`): anything that widens
 * what agents may do without asking waits for the owner unless the dial is on
 * `trusted`, and then only under evidence thresholds and on probation.
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
  /** Outcomes: for kind `revert_improvement`, the applied improvement the record says made things worse. */
  outcomesRevertOf?: ID | null;
  /** autopilot: who applied it, how to undo it, its probation and whether it was taken back. Absent on records from before the autopilot. */
  autopilot?: ImprovementAutopilot | null;
  /** What applying replaced, kept so the change can be reversed (set when applied; shape depends on the action). */
  previous?: unknown;
}

export interface SelfImprovementSettings {
  enabled: boolean;
  /** When workers are asked to reflect: after tasks that hit friction, after every task, or never. */
  retrospectives: 'off' | 'friction' | 'always';
  /** Lessons employees propose for the whole project/company become active without owner review. */
  autoApproveSharedLessons: boolean;
  /** Let measured outcomes influence which employee the scheduler picks. */
  learnedRouting: boolean;
  /**
   * Choose the lessons of a task prompt by how well they fit the task (default on). Off: the newest twelve by scope,
   * as before. Read through `playbookSettings()`, which supplies the defaults and the bounds.
   */
  playbookRelevance?: boolean;
  /** How many characters of lessons a task prompt may carry (default 2400, kept within 400–8000). */
  playbookBudgetChars?: number;
  /** Outcomes: retire a lesson by itself once the record shows, with enough tasks, that it is not helping or is making things worse. */
  outcomesAutoRetire: boolean;
  /**
   * autopilot: what the office applies by itself.
   * off = nothing, every suggestion waits; safe = only changes that cannot widen what agents may do without asking;
   * trusted = also widening changes, under evidence thresholds, each on probation and taken back on a counter-signal.
   */
  autopilot: AutopilotMode;
  /** autopilot: at most this many automatic changes per project per day (1–20). */
  autopilotMaxPerDay: number;
}

/** capture: where a lesson came from, with the exact words or output it was derived from. */
export interface CaptureOrigin {
  /**
   * retrospective     the employee's own session recorded it (record_lesson)
   * correction        a message to the employee that reads as a standing rule ("don't…", "from now on…")
   * review_rejection  the owner sent work back with a comment
   * denial            the owner denied an action and said why
   * repeat_failure    verification failed the same way on more than one task of the project
   */
  kind: 'retrospective' | 'correction' | 'review_rejection' | 'denial' | 'repeat_failure';
  /** Whose words they are ("the boss", a colleague's name), for the kinds that quote a person. */
  from?: string | null;
  /** Who was being told. */
  toEmployeeId?: ID | null;
  taskId?: ID | null;
  taskKey?: string | null;
  /** The words or output the lesson was derived from, unedited (shortened). */
  quote?: string;
  /** correction: the wording that made the message count as a rule, so the match can be judged. */
  matched?: string;
  /** What the lesson is about, in a form that can be compared: the friction of the task (retrospective) or the failure (repeat_failure). */
  signatures?: string[];
}

/** capture: one thing an employee's finished work shows. Counts from records, never a judgement. */
export interface MeasuredSkill {
  kind: 'task_kind' | 'file_type' | 'directory' | 'tool';
  /** Ready to show: "bug", ".ts", "src/api", "Bash". */
  label: string;
  /** Finished tasks behind it; for a tool, uses reported by the session's hooks. */
  count: number;
  /** task_kind only: how many of those passed verification and review the first time. */
  firstPass?: number;
}

// ── Outcomes: did what the office learned help? (docs/learning/outcomes.md) ──

/** What one task cost on its way to done. Derived from the task's own record; nothing is estimated. */
export interface TaskOutcome {
  taskId: ID;
  key: string;
  projectId: ID;
  employeeId: ID | null;
  kind: TaskKind;
  startedAt: ISODate | null;
  completedAt: ISODate | null;
  /** Done with no failed verification and no review rejection. */
  firstPass: boolean;
  /** Orchestrator ran a verification command itself and it passed (not only the employee's word). */
  verified: boolean;
  failedVerifications: number;
  reviewRejections: number;
  mergeConflicts: number;
  blockers: number;
  /** Questions put to the owner (permission requests are counted separately). */
  questions: number;
  approvalsAsked: number;
  approvalsDenied: number;
  /** Times the employee stopped without finishing and was told to continue, in the last hand-over (the counter restarts with each hand-over). */
  nudges: number;
  /** Times the work came back to the employee: after a failed verification or a review that asked for changes. */
  sentBack: number;
  /** Wall time from the first start to done, waiting included. Null when either end was not recorded. */
  cycleMs: number | null;
  /** Tokens used on the task, when the task record carries them (it does not today). */
  tokens: number | null;
  /** The counts above as one number; the weights are in `FRICTION_WEIGHTS` (docs/learning/outcomes.md). 0 is a clean run. */
  frictionScore: number;
}

/** A group of finished tasks in numbers. Rates and means are null for an empty group. */
export interface OutcomeStats {
  tasks: number;
  firstPass: number;
  firstPassRate: number | null;
  meanFriction: number | null;
  questionsPerTask: number | null;
  approvalsPerTask: number | null;
  /** Median wall time from start to done, over the tasks where both were recorded. */
  medianCycleMs: number | null;
}

/** One row of a trend table or one point of a trend chart. */
export interface OutcomeTrendRow extends OutcomeStats {
  /** Project id, employee id, task kind, or the Monday (UTC, YYYY-MM-DD) a week starts on. */
  key: string;
  label: string;
}

export interface OutcomeTrends {
  overall: OutcomeStats;
  /** The last `window` finished tasks against the `window` before them. */
  recent: { window: number; last: OutcomeStats; previous: OutcomeStats };
  /** Oldest first, one row per week, weeks without finished tasks included. */
  byWeek: OutcomeTrendRow[];
  byProject: OutcomeTrendRow[];
  byEmployee: OutcomeTrendRow[];
  byKind: OutcomeTrendRow[];
}

/**
 * helping       — measurably better, with enough tasks on both sides.
 * no_effect_yet — nothing can be said yet (`reason` says why; `needed` says how many more tasks).
 * not_helping   — enough tasks, there was room to improve, and a worthwhile improvement is ruled out.
 * harmful       — measurably worse, with enough tasks on both sides.
 */
export type OutcomeVerdict = 'helping' | 'no_effect_yet' | 'not_helping' | 'harmful';
/** Why a verdict is `no_effect_yet`: too few comparable tasks, a difference that is not clear, measures that disagree, or nothing to improve on. */
export type OutcomeUndecided = 'too_few' | 'unclear' | 'mixed' | 'no_room';

/** One measure compared between two groups of comparable tasks (same project, kind and employee). */
export interface OutcomeComparison {
  /** Tasks on each side that have a comparable task on the other side. */
  tasksA: number;
  tasksB: number;
  /** Mean (or rate) on side A; side B's is re-weighted to A's mix of project, kind and employee. */
  a: number | null;
  b: number | null;
  /** a − b, its standard error, and the two divided. Null when there is nothing to compare. */
  diff: number | null;
  se: number | null;
  z: number | null;
}

export interface LessonOutcome {
  lessonId: ID;
  text: string;
  scope: Lesson['scope'];
  employeeId: ID | null;
  projectId: ID | null;
  status: Lesson['status'];
  proven: boolean;
  /** recorded: the tasks say which lessons they were given. inferred: worked out from dates (every lesson in scope that existed when the task started). */
  basis: 'recorded' | 'inferred';
  /** Every finished task that was given it / that could have been and was not (the tasks it was learned from are in neither). */
  given: number;
  notGiven: number;
  /** A = tasks given the lesson, B = comparable tasks without it. */
  firstPass: OutcomeComparison;
  friction: OutcomeComparison;
  verdict: OutcomeVerdict;
  reason: OutcomeUndecided | null;
  /** How many more comparable tasks each side needs before there can be a verdict; null when there are enough. */
  needed: { with: number; without: number } | null;
  /** The verdict as one line of plain English, ready to show. */
  line: string;
}

export interface ImprovementOutcome {
  improvementId: ID;
  kind: ImprovementKind;
  title: string;
  decidedAt: ISODate;
  /** Whose tasks are compared: one project's, one employee's, or (both null) the whole office's. */
  projectId: ID | null;
  employeeId: ID | null;
  /** What this kind of change is judged on, e.g. approvals asked per task for an allow rule. */
  metric: { key: string; label: string; better: 'higher' | 'lower'; before: number | null; after: number | null };
  /** The last tasks finished before the change and the first ones started after it. */
  before: OutcomeStats;
  after: OutcomeStats;
  /** A = after, B = before. */
  comparison: OutcomeComparison;
  /** For changes that widen what agents may do: the first-pass rate must not fall. Null for other kinds. */
  guard: OutcomeComparison | null;
  verdict: OutcomeVerdict;
  reason: OutcomeUndecided | null;
  needed: { before: number; after: number } | null;
  line: string;
  /** The `revert_improvement` suggestion raised because of this, if any. */
  revertProposalId: ID | null;
}

/** GET /api/growth/outcomes */
export interface OutcomesReport {
  generatedAt: ISODate;
  /** Finished tasks the figures are counted from. */
  tasks: number;
  /** The rules behind every verdict, so a screen can explain them. */
  thresholds: { minTasksPerSide: number; minTasksToRetire: number; minTasksForNoBenefit: number; minFirstPassDifference: number; confidence: number; confidenceNoBenefit: number; window: number };
  trends: OutcomeTrends;
  lessons: LessonOutcome[];
  improvements: ImprovementOutcome[];
}

export type AutopilotMode = 'off' | 'safe' | 'trusted';

/** autopilot: the inverse of an applied `ImprovementAction`, with what was there before it. */
export type AutopilotUndo =
  | { type: 'project.policy.allow'; projectId: ID; rule: string; /** false: the rule was already there, so undoing removes nothing */ added: boolean }
  | { type: 'project.policy.deny'; projectId: ID; rule: string; added: boolean }
  | { type: 'project.requireReview'; projectId: ID; previous: boolean; applied: boolean }
  | { type: 'project.verifyTimeout'; projectId: ID; previous: number; applied: number }
  | { type: 'employee.autonomy'; employeeId: ID; previous: AutonomyLevel; applied: AutonomyLevel }
  /** A change made by one of the detectors' own actions: what was there before is on the improvement itself (`previous`). */
  | { type: 'detect' }
  | { type: 'advice' };

/** autopilot: the trial period of a change the office made by itself. */
export interface AutopilotProbation {
  startedAt: ISODate;
  /** It ends at this time… */
  until: ISODate;
  /** …or once this many more tasks of the affected project or employee have finished, whichever comes first. */
  tasksLeft: number;
  /** The finished tasks counted so far. */
  taskIds: ID[];
  /** running; passed = it ended without a counter-signal; reverted = a counter-signal took the change back; ended = a person undid or replaced the change first. */
  status: 'running' | 'passed' | 'reverted' | 'ended';
}

/** autopilot: the record kept with an applied improvement so that it can be explained and reversed. */
export interface ImprovementAutopilot {
  /** 'autopilot', or the person as the audit log names them ('owner', 'member:<name>'). */
  appliedBy: string;
  /** True when the office applied it by itself. */
  auto: boolean;
  appliedAt: ISODate;
  /** Whether the change widened what agents may do without asking, judged when it was applied. */
  widening: boolean;
  undo: AutopilotUndo | null;
  /** Only changes the office made by itself are on probation. */
  probation: AutopilotProbation | null;
  /** Set when it was taken back. `restored` is false when there was nothing left to restore (a person had changed the setting since). */
  reverted: { at: ISODate; by: string; reason: string; evidence: EvidenceRef[]; restored: boolean; note: string } | null;
  /** The autopilot will not apply this one again by itself: it was taken back once. */
  noAuto: boolean;
  history: Array<{ ts: ISODate; what: 'applied' | 'reverted' | 'kept'; by: string; note: string }>;
}

// ──────────────────────────── Foreman ────────────────────────────

/**
 * Rounds of the foreman: the office's one supervisor (an employee with the `foreman` role, on one of the
 * office's own machines, with no desk). A round is one prompt delivered to the foreman's own Claude Code
 * session, so each one uses that account's Claude usage; the office decides when one is due without any model.
 */
export interface ForemanSettings {
  /** Nothing is ever delivered to a foreman while this is off. Hiring a foreman switches it on; the owner can pause it. */
  enabled: boolean;
  /** The shortest time between the end of one round and the start of the next. */
  minGapSeconds: number;
  /** With nothing waiting, one look around at most this often, and only if the office changed. 0 = never. */
  quietCheckMinutes: number;
  /** Employees' questions go to the foreman first. Permission requests never do. */
  answersQuestions: boolean;
  /** Someone whose session has sat between turns this long with nothing in progress is put in front of the foreman, once. 0 = never. */
  idleMinutes: number;
}

/**
 * question: an employee asked and nobody answered. blocked: a blocked task. stalled: idle with a task in progress.
 * unassigned: ready work next to someone free. idle: a live session with nothing in progress, doing nothing.
 * waiting: an employee who cannot go on until a colleague answers or finishes, while that colleague is doing nothing.
 */
export type ForemanAttentionKind = 'question' | 'blocked' | 'stalled' | 'unassigned' | 'idle' | 'waiting';

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
  /** Further employees with the foreman role, from before there could only be one: they have the tools, but rounds go to one. */
  otherForemen: string[];
  /** Who the foreman is with right now (it looked at them, answered them, told them something) while a round runs. */
  visiting: ID | null;
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
  /** 0–1. Only where a computer's own volume starts from: how loud each person hears the hi-fi is theirs (the app's preferences). */
  volume: number;
  /** The station that was last played (the office notes it when someone switches one on); nothing starts by itself. */
  lastStationId: string | null;
}

/**
 * What the office's hi-fi is playing right now, for everyone in the office. Kept by the server in memory: after a
 * restart the hi-fi is off. Each window plays the stream itself; the office only says what is on.
 */
export interface RadioNow {
  /** One of the office's saved stations, as it was when it was switched on. */
  station: RadioStation;
  since: ISODate;
  /** Who switched it on: the member's id ('owner' for the root owner) and their name. */
  by: { id: string; name: string };
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
  /** Is somebody logged in to Claude Code in that folder? Null: not asked yet (or the machine is away). */
  loggedIn?: boolean | null;
  /** Used up for now: a window is at its limit and has not reset. */
  exhausted?: boolean;
  /** A turn on this account was refused for its limit; it counts as used up until then (the figures above do not show every limit). */
  spentUntil?: ISODate | null;
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
  /** The office hi-fi's stations. What is playing is the office's too (`RadioNow`), heard by everyone in it; nothing is sent to employees. */
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
   * true (default): any employee may keep the task board moving — release a task, unblock one (saying how), give a
   * task to a colleague, review a colleague's finished work, and start a colleague who is needed. false: those are
   * the owner's (and, for assigning, the foreman's). Either way no employee approves a permission request, marks
   * work done without verification, or deletes anything.
   */
  employeesManageBoard?: boolean;
  /**
   * true (default): where MemPalace is installed on the office's own machine, the office keeps a long memory in it —
   * finished tasks, answers, resolved blockers, lessons, meeting decisions, employees' notes — and employees can ask it.
   * false: nothing is filed and nothing is recalled (what is already filed stays where it is).
   */
  longMemory?: boolean;
  /**
   * false (default): the whip is a gag — a sound and a flinch, and nothing else. true: cracking it at an employee who
   * is waiting for a permission approves that request, for whoever may decide it anyway (it is on the record as
   * theirs, like an approval from the Inbox). Off unless an owner switches it on: a joke must not approve a command.
   */
  whipApproves?: boolean;
  /**
   * true (default): when the Claude account an employee runs on has used up its allowance and another account on the
   * same machine has room, the office puts the employee on that one and restarts their session there. false: they
   * wait for the account to reset.
   */
  accountFailover?: boolean;
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
  /**
   * Sessions on the office's own machines that have had no work for this many minutes are stopped to free memory
   * ("asleep"); what they are next needed for starts them again, continuing the same conversation. 0: never.
   */
  sleepAfterMinutes: number;
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
