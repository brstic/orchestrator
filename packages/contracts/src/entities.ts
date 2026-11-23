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
  /** The newest hook commands this machine's agent writes for a session (`HOOKS_VERSION` of its build); absent from older agents. */
  hooksVersion?: number;
  /** This machine's agent says what it holds a command for (`orch_held_for`), so the office can answer for the high-risk list by itself where the owner switched the hold off. Absent from older agents. */
  saysHeldFor?: boolean;
  /** This machine's agent fences a rented employee to their folders (`LaunchSpec.fence`, `session.fence`; docs/RENT.md). Absent from older agents. */
  rentFence?: boolean;
  /** This machine's agent holds a release for the office to decide (`LaunchSpec.release`, `session.release`; docs/RELEASE-GATE.md). Absent from older agents. */
  releaseGate?: boolean;
  hostname: string;
  platform: string;
  arch: string;
  agentVersion: string;
  tmuxVersion: string | null;
  claudeVersion: string | null;
  /** The effort levels this machine's Claude Code accepts (`claude --effort …`), read from its own help text. Empty: it has no such option. Absent: an agent from before this was reported. */
  claudeEffortLevels?: string[];
  /**
   * A browser the employees on this machine can drive (Playwright's MCP server, headless): its version, and which
   * browser it runs. Absent or null: none is installed here.
   */
  browser?: { mcp: string; engine: string } | null;
  cpus: number;
  totalMemBytes: number;
  user: string;
  /** This machine's agent can move an employee's folder and conversation to or from another machine (`docs/MOVE.md`). */
  moves?: boolean;
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
 * How much an employee may do without asking. Three levels, and no others (the owner's decision of 2026-11-13;
 * see DECISIONS.md, "Three levels"):
 *
 *   `standard`      edits and routine commands by themselves; everything else is asked.
 *   `auto`          Claude Code's own auto mode (its safety classifier) decides what may run, so the owner is asked
 *                   for decisions and direction only.
 *   `unrestricted`  Claude Code's bypass-permissions mode — nothing is checked or asked by Claude Code itself; what
 *                   still holds is the project's deny rules and the office's own gate for high-risk commands. The
 *                   owner's default since 2026-11-11 (their decision; see DECISIONS.md). Interactive sessions only.
 */
export type AutonomyLevel = 'standard' | 'auto' | 'unrestricted';
/** The levels, from the least to the most an employee does unasked. */
export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['standard', 'auto', 'unrestricted'];
export const isAutonomyLevel = (value: unknown): value is AutonomyLevel => AUTONOMY_LEVELS.includes(value as AutonomyLevel);

export type CommunicationStyle =
  | 'concise'
  | 'analytical'
  | 'cautious'
  | 'experimental'
  | 'detail-oriented'
  | 'architecture-focused'
  | 'highly-independent'
  | 'review-focused';

/** An employee's move to another machine as it goes (`docs/MOVE.md`). */
export interface EmployeeMoving {
  id: string;
  fromHostId: ID;
  toHostId: ID;
  /** packing → sending → unpacking; `failed` keeps the reason in `error` (the employee stayed where they were). */
  phase: 'packing' | 'sending' | 'unpacking' | 'failed';
  sent: number;
  total: number;
  startedAt: ISODate;
  by: string;
  error: string | null;
}

export type ExecutionMode = 'interactive_cli' | 'managed_sdk' | 'codex_managed';

export type HairStyle = 'short' | 'long' | 'bun' | 'bald' | 'curly' | 'buzz' | 'ponytail' | 'afro' | 'mohawk';
export type Outfit = 'polo' | 'shirt' | 'tee' | 'sweater' | 'suit';
export type FacialHair = 'none' | 'stubble' | 'mustache' | 'goatee' | 'beard';

/**
 * How a figure looks — an employee's (chosen in their profile, or made up when they are hired) or a person's own
 * character (the character creator: `docs/CHARACTER.md`). The first seven are always there; the rest are chosen in
 * the creator, and where one is absent the office decides it from the look as it always did (the outfit, the face,
 * the eyes, the shoes…), so a look saved before they existed is drawn exactly as it was.
 */
export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  shirt: string;
  pants: string;
  /** What is worn on the head or the face. With `glasses` true, glasses as well (e.g. a cap and glasses). */
  accessory: 'none' | 'glasses' | 'headphones' | 'cap';
  build: number; // 0.9 – 1.1 body scale
  outfit?: Outfit;
  glasses?: boolean;
  facialHair?: FacialHair;
  /** One of the faces (0 soft oval, 1 round, 2 longer with a firm jaw). */
  face?: number;
  /** One of the brows (0 … 4). */
  brows?: number;
  /** Eye colour. */
  eyes?: string;
  /** How broad the body is, 0.94 – 1.08 (`build` is how big all of it is). */
  girth?: number;
  shoes?: string;
  /** The tie, with a suit. */
  tie?: string;
}

/** A look to fill in what an incoming look leaves out (the office's own figures are each made up in full). */
export const DEFAULT_LOOK: Appearance = { skin: '#e0ac69', hair: '#241c17', hairStyle: 'short', shirt: '#2b3c66', pants: '#2b3c66', accessory: 'none', build: 1 };

export const HAIR_STYLES: readonly HairStyle[] = ['short', 'buzz', 'long', 'ponytail', 'bun', 'curly', 'afro', 'mohawk', 'bald'];
export const OUTFITS: readonly Outfit[] = ['polo', 'shirt', 'tee', 'sweater', 'suit'];
export const FACIAL_HAIR: readonly FacialHair[] = ['none', 'stubble', 'mustache', 'goatee', 'beard'];
export const FACE_SHAPES = 3;
export const BROW_SHAPES = 5;

const HEX = /^#[0-9a-f]{6}$/i;
const colourOr = (v: unknown, or: string): string => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : or);
const oneOf = <T extends string>(v: unknown, list: readonly T[], or: T): T => (list.includes(v as T) ? (v as T) : or);
const within = (v: unknown, lo: number, hi: number, or: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : or);

/**
 * A look as it may be kept: every field of the right kind and within its range, anything else dropped. What is
 * missing or wrong falls back to `base`. Used wherever a look comes in from outside (a person's own character).
 */
export function cleanAppearance(input: unknown, base: Appearance): Appearance {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Appearance = {
    skin: colourOr(a.skin, base.skin),
    hair: colourOr(a.hair, base.hair),
    hairStyle: oneOf(a.hairStyle, HAIR_STYLES, base.hairStyle),
    shirt: colourOr(a.shirt, base.shirt),
    pants: colourOr(a.pants, base.pants),
    accessory: oneOf(a.accessory, ['none', 'glasses', 'headphones', 'cap'] as const, base.accessory),
    build: Math.round(within(a.build, 0.9, 1.1, base.build) * 100) / 100,
  };
  if (a.outfit !== undefined) out.outfit = oneOf(a.outfit, OUTFITS, 'polo');
  if (a.glasses !== undefined) out.glasses = a.glasses === true;
  if (a.facialHair !== undefined) out.facialHair = oneOf(a.facialHair, FACIAL_HAIR, 'none');
  if (a.face !== undefined) out.face = Math.round(within(a.face, 0, FACE_SHAPES - 1, 0));
  if (a.brows !== undefined) out.brows = Math.round(within(a.brows, 0, BROW_SHAPES - 1, 0));
  if (a.eyes !== undefined) out.eyes = colourOr(a.eyes, '#5a3a22');
  if (a.girth !== undefined) out.girth = Math.round(within(a.girth, 0.94, 1.08, 1) * 100) / 100;
  if (a.shoes !== undefined) out.shoes = colourOr(a.shoes, '#1b1c20');
  if (a.tie !== undefined) out.tie = colourOr(a.tie, '#8f2738');
  return out;
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
  /** Hired by a member's team lead (that lead's id): what the lead's limit counts. Absent: hired by a person. */
  hiredBy?: ID | null;
  /**
   * A shared employee a member looks after: it stays shared — on the office's machine, for everyone who works here to
   * see and use — and is listed among that member's own (My work, Mine, their team lead's team). One member at a time.
   * Says nothing about access. Absent on a member's own computer, where everything is that member's already.
   */
  keptBy?: { id: ID; name: string } | null;
  /** A team lead only: whose employees it directs — its member's own (`own`, the default), or the office's shared ones too (`office`). */
  leadScope?: 'own' | 'office';
  /**
   * A person's own session: someone sat down at a desk and opened Claude Code for themselves. They type into it;
   * the office gives it no work of its own accord and does not nudge it.
   */
  selfDriven?: boolean;
  /** capture: projects whose "what this team has learned" digest this employee was already given (once, with their first task there). */
  captureOnboarded?: ID[];
  /** capture: what their finished work shows, counted from task records and hook events. `skills` above is what was declared at hiring. */
  captureSkills?: MeasuredSkill[];
  /** What they keep working toward until it holds (`EmployeeGoal`), or the last one, met or stopped. Absent: never had one. */
  goal?: EmployeeGoal | null;
  /** Being moved to another machine, with their folder and conversation (`docs/MOVE.md`); kept with `error` when it failed. */
  moving?: EmployeeMoving | null;
}

/**
 * A goal (like Claude Code's `/goal`): a condition the employee keeps working toward, turn after turn, until it holds.
 * When their turn ends while it does not, the office sends them on (through the Stop hook); they say when it holds
 * (`goal_met`), and where a person gave a command to check it by, that command decides.
 */
export interface EmployeeGoal {
  /** What has to be true, in words: "every test in packages/api passes and the branch is pushed". */
  condition: string;
  /** A shell command, run in their folder, that succeeds once the condition holds. Only a person gives one. */
  check: string | null;
  /** Who set it: a person by name, or the employee themselves. */
  setBy: { kind: 'owner' | 'employee'; id: ID | null; name: string };
  setAt: ISODate;
  status: 'active' | 'met' | 'stopped';
  /** How many times the office sent them on toward it. */
  turns: number;
  /** Turns in a row that ended without anything done (no tool used); at three the goal stops. */
  idle: number;
  endedAt: ISODate | null;
  /** Met: how they showed it holds. Stopped: why it stopped (cleared, no progress, the turn limit). */
  outcome: string | null;
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
  | 'paused'
  /** Between turns, while a command it started goes on running in the background (`AgentSession.background`). */
  | 'waiting_command';

/**
 * The states in which an employee is doing something — as opposed to being away, between turns, or waiting for
 * somebody (an answer, an approval, a colleague). What "time worked" is counted from (`WorkLog`).
 */
export const WORKING_STATES: readonly ActivityState[] = ['thinking', 'reading', 'coding', 'testing', 'debugging', 'running_command', 'researching', 'planning', 'reviewing', 'delegating', 'meeting'];
export const isWorking = (state: ActivityState | null | undefined): boolean => !!state && WORKING_STATES.includes(state);

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
  codexThreadId?: string | null;
  status: SessionStatus;
  activity: ActivityState;
  /** Short human-readable detail, e.g. "Edit src/auth.ts". Sourced from hooks. */
  activityDetail: string | null;
  activitySince: ISODate;
  /**
   * What the agent last wrote in words in the turn in progress — the sentence above the tool it runs, as its
   * terminal shows it. null between turns and before it has said anything. Absent where its machine's agent is older.
   */
  saying?: string | null;
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
  /**
   * What the session was doing when the office lost sight of it (its machine went away, or the office was started
   * again), and when. If sight comes back within a few minutes and the session was between turns, that is still
   * what it is doing — instead of "unknown" on every desk after every restart.
   */
  activityBefore?: { state: ActivityState; detail: string | null; at: ISODate } | null;
  /** The Claude account folder this session's process was started with (null: the machine's default login). Absent on older records. */
  claudeConfigDir?: string | null;
  /** Which version of the hook commands the session runs with, as its machine's agent reports it (see `HOOKS_VERSION`). */
  hooksVersion?: number;
  /** Was this session started with the office's high-risk list in front of it? (false: its machine holds nothing of it.) Absent on older records. */
  highRiskHeld?: boolean;
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
  /** The version of the central context this session was last given (`docs/CONTEXT.md`); absent: none yet. */
  contextRev?: string | null;
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
  /**
   * Commands this session started that are still running in the background — Claude Code's `run_in_background`, a
   * command moved there after its time ran out, or one the person at the terminal sent there. Seen by its machine
   * (the shell Claude Code started for the command is still alive); the one the session is running in front of it
   * now is not among them. Null or absent: none (or a machine whose agent does not say).
   */
  background?: BackgroundCommand[] | null;
}

/** One command running in a session's background. */
export interface BackgroundCommand {
  /** What it is, in Claude Code's own words for it where it gave some ("Run the full test suite"), else the command. */
  what: string;
  /** Since when it has been running. */
  since: ISODate;
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
  /**
   * Who reviews this project's finished work, when nobody chose for the task. Absent or null: as the office does
   * (`OwnerSettings.reviewDefault`). Set, it stands in for the office's setting for this project alone (`reviewUsualOf`).
   */
  review?: ReviewBy | null;
  /**
   * Seconds for which what one employee writes to another of this project (a message, a comment on a ticket) is
   * kept before it is typed to a recipient who sits idle, so that several arrive in one turn of their session
   * instead of one turn each. Absent, null or 0: at once, as before. Never applied to a person's words, a task, an
   * answer, a routine, or a request somebody waits on (`gatherSecOf`).
   */
  gatherSec?: number | null;
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
  /** A copy made when an employee was moved to another machine out of this project (`docs/MOVE.md`): moved back, their branches go back into it. */
  copiedFrom?: { projectId: ID; hostId: ID } | null;
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
  /** The commit the task's branch stood at when the work was handed in and checked: what is reviewed, and what is merged — not whatever the branch points at later. */
  headSha?: string | null;
  filesChanged: string[];
  diffStat: string | null;
  verification: VerificationResult | null;
  review: { reviewerId: ID | null; verdict: 'approved' | 'changes_requested'; comments: string; ts: ISODate; by: 'employee' | 'owner' } | null;
  /** `reviewBy: 'both'`: the colleague's approval that sent the work on to the boss. Cleared when the work is handed in again. */
  peerReview?: { reviewerId: ID; comments: string; ts: ISODate } | null;
  /** A colleague asked for changes after the task had been sent back `REVIEW_SEND_BACKS` times: it was not sent back again, and waits for the boss with what they asked for. */
  contested?: { reviewerId: ID; comments: string; ts: ISODate } | null;
  merge: { ts: ISODate; ok: boolean; sha: string | null; into: string; detail: string } | null;
}

/** A file on a task: something a person attached for the employee to work from, or evidence an employee left. The bytes are in the office's data folder. */
export interface TaskAttachment {
  id: ID;
  /** The file's name, safe to stand in a folder and unique within its task. */
  name: string;
  mime: string;
  size: number;
  /** `input`: attached by a person for whoever does the task. `evidence`: left by the employee to show the work. */
  kind: 'input' | 'evidence';
  caption: string | null;
  addedBy: { kind: 'owner' | 'member' | 'employee'; id: ID | null; name: string };
  addedAt: ISODate;
  sha256: string | null;
  /** Where a copy stands on each machine it was sent to (host id → path there), for the employee to open. */
  paths?: Record<ID, string>;
}

/**
 * Who has to approve a finished task before it is done: `both` — a colleague first, then the boss (the default);
 * `boss`; `peer` — a colleague, the boss only when there is nobody to review; `none`. See `docs/TASKS.md`.
 */
export type ReviewBy = 'both' | 'boss' | 'peer' | 'none';
export const REVIEW_BY: ReviewBy[] = ['both', 'boss', 'peer', 'none'];
/**
 * How many times a colleague may send the same task back. The next time a colleague asks for changes, the task is
 * not sent back again: it waits for the boss, who approves it as it is or sends it back themself.
 */
export const REVIEW_SEND_BACKS = 2;
/** The longest a project may gather its employees' messages for, and what it gathers for when nothing is set (not at all). */
export const GATHER_SEC_MAX = 600;
export function gatherSecOf(project: { policy?: { gatherSec?: unknown } | null } | null | undefined): number {
  const n = Number(project?.policy?.gatherSec);
  return Number.isFinite(n) && n > 0 ? Math.min(GATHER_SEC_MAX, Math.floor(n)) : 0;
}
/** What a task is reviewed by when nobody chose: the office's setting, else a colleague and then the boss. */
export function reviewDefaultOf(settings: { reviewDefault?: unknown } | null | undefined): ReviewBy {
  return REVIEW_BY.includes(settings?.reviewDefault as ReviewBy) ? (settings!.reviewDefault as ReviewBy) : 'both';
}
/** The same for a task of one project: the project's own way where it has one (`ProjectPolicy.review`), else the office's. */
export function reviewUsualOf(settings: { reviewDefault?: unknown } | null | undefined, project: { policy?: { review?: unknown } | null } | null | undefined): ReviewBy {
  const own = project?.policy?.review;
  return REVIEW_BY.includes(own as ReviewBy) ? (own as ReviewBy) : reviewDefaultOf(settings);
}
/** Who reviews this task (tasks from before `reviewBy` existed: a colleague when there is one, as it was). */
export function reviewByOf(task: { reviewBy?: ReviewBy; requiresReview: boolean }): ReviewBy {
  if (!task.requiresReview) return 'none';
  return task.reviewBy && task.reviewBy !== 'none' ? task.reviewBy : 'peer';
}

/** Somebody a comment is addressed to: the boss (the people of the office) or an employee. */
export type TaskMention = { kind: 'boss' } | { kind: 'employee'; id: ID; name: string };

/**
 * One entry of the conversation on a task. People and employees write them; the office writes the ones that mark
 * what happened (approved, sent back, split, a part finished).
 * - `note`: said. `question`: asked, and the work waits for the answer (`answeredBy`: the comment that answered it).
 * - `answer`: the answer to a question (`answerTo`). `approved` / `sent_back`: a review verdict, or a finished task opened again.
 * - `handed_in`: the work was handed in (the employee's summary). `handoff`: passed to a colleague. `split`: divided into parts. `part_done`: a part was finished.
 */
export interface TaskComment {
  id: ID;
  ts: ISODate;
  from: { kind: 'owner' | 'member' | 'employee' | 'office'; id: ID | null; name: string };
  body: string;
  kind: 'note' | 'question' | 'answer' | 'handed_in' | 'approved' | 'sent_back' | 'handoff' | 'split' | 'part_done';
  mentions: TaskMention[];
  /** `question` put to the boss: the office's question it is (the same one the Inbox shows). */
  questionId?: ID | null;
  /** `question`: the comment that answered it; null while it is open. */
  answeredBy?: ID | null;
  /** `answer`: the question it answers. */
  answerTo?: ID | null;
  /** `question`: the answers whoever asks proposes — the boss picks one with a click, or writes their own. */
  options?: QuestionOption[];
  /** Files of the task that were left with this comment (pictures are shown under it). */
  attachmentIds?: ID[];
}

/** How many comments a task keeps (the oldest go first). */
export const TASK_COMMENTS_MAX = 300;

export interface TaskHistoryEntry {
  ts: ISODate;
  status: TaskStatus;
  note: string;
  by: string;
}

/** A task's release (`Task.release`, docs/RELEASE-GATE.md). */
export interface TaskRelease {
  plan: string | null;
  approvedAt?: ISODate | null;
  approvedBy?: string | null;
  /** The gate stands open for those who release it until then. */
  openUntil?: ISODate | null;
  releasedAt?: ISODate | null;
  releasedBy?: string | null;
  note?: string | null;
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
  /**
   * Assigned to a person of the office instead of an employee (an owner or a colleague; `'owner'` for the root
   * owner): they are told in their Inbox, and they move it on themselves. The office never hands it to an employee,
   * starts it or checks it. Null (or absent): not a person's. Exclusive with `assigneeId`.
   */
  personId?: string | null;
  /** Their name when it was assigned (kept: a member who has left still shows who it was). */
  personName?: string | null;
  /**
   * Closed without being done: no longer wanted (`cancel_task`). The task stays, DONE, with who and why; moved back
   * on the board by a person, it is not cancelled any more. Null (or absent): not cancelled.
   */
  cancelled?: { at: ISODate; by: string; reason: string } | null;
  /**
   * Where the work goes once approved, and how far it got (docs/RELEASE-GATE.md): the plan the author handed in with
   * it (`complete_task` `release_plan`), when an owner approved it and so opened the gate (until when), and the
   * author's word that it is out (`report_released`).
   */
  release?: TaskRelease | null;
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
  /** Files on the task (see `TaskAttachment`). Absent: none. */
  attachments?: TaskAttachment[];
  requiresReview: boolean;
  /** Who reviews it (see `ReviewBy`); `requiresReview` is `reviewBy !== 'none'`. Absent on tasks from before it existed. */
  reviewBy?: ReviewBy;
  /** While in REVIEW: whose turn it is — a colleague's (`peer`) or the boss's. */
  reviewStage?: 'peer' | 'boss' | null;
  /** The conversation on the task. Absent: nothing was said yet. */
  comments?: TaskComment[];
  /**
   * Why a BLOCKED task waits, when it waits for something that will come rather than for a problem to be solved:
   * the answer to a question asked in its conversation, or the parts it was split into.
   */
  waitingFor?: { kind: 'answer'; commentId: ID } | { kind: 'parts' } | null;
  /** The task this one is a part of (it was split off by that task's assignee). */
  parentId?: ID | null;
  /** Colleagues put on the task with its assignee, who leads it. */
  helperIds?: ID[];
  /** How many times it was opened again after it was done (each time its work starts on a fresh branch). */
  reopened?: number;
  reviewerId: ID | null;
  /** Who did the work that is in review (the assignee when it was handed in): never its reviewer, whoever the task is given to afterwards. */
  authorId?: ID | null;
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
/** `auto_denied`: Claude Code's own safety check (auto mode) refused an action; the owner may allow it once (see `SessionRegistry.grantOnce`). */
export type QuestionChannel = 'mcp_tool' | 'permission_hook' | 'ask_user_question_hook' | 'terminal' | 'system' | 'auto_denied';

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
  /**
   * For permission requests: the real tool and input Claude wants to run. `notShown`: how many characters of the
   * input are not in `input` (it is longer than the office keeps for showing). What is allowed is the whole input,
   * so a request with anything not shown cannot be allowed from the office — only denied, or decided at the terminal.
   */
  tool: { name: string; input: unknown; notShown?: number } | null;
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
   * For a question held on a Claude Code hook: the id of the hook event it came with. With it the office takes the
   * same question up again when the machine sends that event again because it is still holding the hook (after a
   * restart of the office, a lost connection, a restart of the machine's agent) instead of letting it fall to
   * Claude Code's own prompt in the terminal.
   */
  hookEventId?: string;
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
  via: 'terminal_paste' | 'stop_hook' | 'mcp_pull' | 'sdk' | 'codex' | null;
  ts: ISODate | null;
  detail: string | null;
}

/** (`comment`: something said on a task's conversation, brought to an employee it concerns — the text says by whom and how to answer.) */
export type MessageKind = 'chat' | 'collab_request' | 'handoff' | 'review_request' | 'review_feedback' | 'task' | 'answer' | 'meeting' | 'system' | 'report_request' | 'comment';

/** A file that went with a message to an employee (a pasted screenshot, a document): what the conversation shows of it. */
export interface SaidFile {
  id: ID;
  name: string;
  mime: string;
  size: number;
}

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
  /** Files that went with it. Their paths on the employee's machine stand at the end of `body`, after `said`. */
  files?: SaidFile[];
  /** What the person wrote, without the lines about files the office added for the employee. Absent: `body` is it. */
  said?: string;
  /**
   * Where it was written, when not in the office's own window: the employee's Telegram bot (`docs/TELEGRAM.md`), or the
   * Rent portal, by a client who rents them (`docs/RENT.md`; `clientId` says which).
   */
  channel?: 'telegram' | 'rent';
  /** The client who wrote it on the Rent portal. */
  clientId?: ID;
  /** The Telegram group it came from (its title); none for a private chat. */
  chat?: string;
}

// ───────────────────────────── Rent ──────────────────────────────
// Employees the office rents out to people who never come into the office: a client talks to them on the Rent portal
// at the office's address, and they work only in their own folders and with each other (`docs/RENT.md`).

/** What a rented employee may do. The owner sets it per employee; the office enforces it on their machine and in its tools. */
export interface RentPerms {
  /** Run shell commands (Bash). */
  commands: boolean;
  /** Change files (Edit, Write, MultiEdit, NotebookEdit). Off: they only read. */
  edit: boolean;
  /** Fetch web pages and search the web. */
  web: boolean;
  /** Talk to and work with the other employees the same client rents. */
  teamwork: boolean;
  /** Files both ways: the client sends files, the employee gives files to the client. */
  files: boolean;
  /** Use the office's vault (its credentials). */
  vault: boolean;
  /** Read and write the office's long memory. */
  memory: boolean;
  /** Beyond their folders: the whole machine and other servers (paths outside their folders, in file tools and in commands). */
  anywhere: boolean;
  /**
   * Never waits for the office: what the switches above allow runs without an approval, the high-risk hold included, and
   * they ask the owner nothing — what is the client's to decide they ask the client. The office's own files stay fenced.
   */
  autonomous: boolean;
  /**
   * Office work: they go on working with the whole office as before — the task board, every colleague (and every
   * colleague reaches them), office work handed to them. Off: walled in with the client's other employees.
   */
  office: boolean;
}

export const RENT_PERMS_DEFAULT: RentPerms = { commands: true, edit: true, web: true, teamwork: true, files: true, vault: false, memory: false, anywhere: false, autonomous: false, office: false };
export const RENT_PERM_KEYS = Object.keys(RENT_PERMS_DEFAULT) as Array<keyof RentPerms>;

export interface Rental {
  employeeId: ID;
  since: ISODate;
  perms: RentPerms;
}

/** Somebody who rents employees of the office. Not a member: they never come into the office. */
export interface RentClient {
  id: ID;
  name: string;
  /** Their company or what they are to the office, as the owner writes it. */
  company: string | null;
  /** The owner's note: what was agreed, what they are for. Never shown to the client or the employees. */
  note: string;
  createdAt: ISODate;
  createdBy: string;
  revokedAt: ISODate | null;
  lastSeenAt: ISODate | null;
  rentals: Rental[];
}

/** One line of a conversation on the Rent portal. */
export interface RentLine {
  id: ID;
  clientId: ID;
  employeeId: ID;
  /** client: what the client wrote; agent: what the employee answered; note: what the office says (could not deliver, started…). */
  from: 'client' | 'agent' | 'note';
  text: string;
  ts: ISODate;
  /** The office's message that carried a client's line to the employee (for its delivery state). */
  messageId?: ID;
  files?: SaidFile[];
}

/** The limits of what a rented employee reaches on its machine (`LaunchSpec.fence`). */
export interface RentFence {
  /** Folders they may read and change: their own, and those of the employees the same client rents (with teamwork). */
  roots: string[];
  commands: boolean;
  edit: boolean;
  web: boolean;
  /** Not fenced to `roots`: the whole machine (the office's own files stay fenced). */
  anywhere?: boolean;
  /** The high-risk list does not hold them (the office's own files still do). */
  autonomous?: boolean;
  /** Who they work for, for the words they are refused with. */
  client: string;
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
  | 'mention'
  | 'milestone'
  | 'improvement'
  /** An employee wrote to a person (`message_person`): addressed — see `Notification.for`. */
  | 'message'
  /** A task was assigned to a person (`Task.personId`): addressed to them. */
  | 'task_assigned'
  | 'info';

/** `Notification.for`: every owner of the office (what an employee writes "to the boss"). */
export const FOR_OWNERS = '#owners';

/**
 * Is this notification for that person? One without `for` is the office's own and goes to everyone who gets
 * notifications (owners and colleagues); one with it only to whom it names — a member's id (`'owner'` for the root
 * owner), or `FOR_OWNERS` for every owner.
 */
export function notificationFor(n: Pick<Notification, 'for'>, who: { id: string; owner: boolean }): boolean {
  if (!n.for?.length) return true;
  return n.for.includes(who.id) || (who.owner && n.for.includes(FOR_OWNERS));
}

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
  /** Addressed to these people only (`notificationFor`); absent for the office's own notifications, which everyone gets. */
  for?: string[];
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

/**
 * Who has worked the most in a calendar month (UTC), and for how long: the employee whose session spent the most
 * time in a working state (`isWorking`). It is this month's leader as soon as anybody has worked this month, and
 * last month's until then. Never a foreman or a team lead: they keep others working.
 */
export interface EmployeeOfMonth {
  employeeId: ID;
  /** "2026-11". */
  month: string;
  /** Time worked in that month, in milliseconds. */
  ms: number;
}

export interface CompanyStats {
  /** See `EmployeeOfMonth`; null until anybody has worked. */
  employeeOfMonth?: EmployeeOfMonth | null;
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
/** The model families a subscription may limit by the week on their own, strongest first; how a model's name is read. */
export const MODEL_FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'] as const;
/** "claude-fable-5-2", "Fable", "fable[1m]" → "fable"; a name that is none of the families → ''. */
export const modelFamily = (model: string | null | undefined): string => MODEL_FAMILIES.find((f) => new RegExp(`(^|[^a-z])${f}([^a-z]|$)`, 'i').test(String(model ?? ''))) ?? '';

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
/**
 * Whose models an account's Claude Code talks to: Anthropic's with a Claude login (`anthropic`), Z.AI's GLM Coding
 * Plan with an API key (`zai`), or another service that speaks the same protocol (`custom`). An account is a Claude
 * config folder either way; for the last two the folder's `settings.json` names the service and holds the key.
 */
/**
 * Whose models a Claude account folder talks to: Anthropic's (a Claude login), or another service's through Claude Code
 * — Z.AI and DeepSeek (both answer Anthropic's API themselves), OpenAI (through a proxy on the machine that speaks
 * Anthropic's API, e.g. LiteLLM or claude-code-router), or any other address (`custom`).
 */
export type AccountProvider = 'anthropic' | 'zai' | 'deepseek' | 'openai' | 'custom';
/** The services an account of another provider can be set up for from the office. */
export type ServiceProvider = Exclude<AccountProvider, 'anthropic'>;

/** What a machine says about one of its Claude config folders (`claude.accounts`, `claude.login`, `claude.provider`). */
export interface AccountInfo {
  /** As it was asked for (`~/.claude-2`); null = the machine's default login. */
  dir: string | null;
  /** Where that is on the machine. */
  path: string;
  exists: boolean;
  /** Somebody is signed in there (a Claude login), or a key is set (another service). */
  loggedIn: boolean;
  email: string | null;
  organization: string | null;
  provider?: AccountProvider;
  /** For a service that is not Anthropic: its address's host name ("api.z.ai"). Never the key. */
  endpoint?: string | null;
  /** The command that signs in to it by hand, on that machine. */
  login: string;
  error?: string;
}

/** A sign-in to Claude Code that is in progress on a machine, in a terminal of its own: what that terminal shows. */
export interface AccountLogin {
  dir: string | null;
  /** The sign-in is still running (false: it finished, or was never started). */
  running: boolean;
  /** The last lines of its terminal, as text. */
  lines: string[];
  account: AccountInfo;
}

export interface AccountUsage {
  /** `<hostId>|<config folder or "default">`. */
  key: string;
  hostId: ID;
  /** The Claude config folder this account lives in on that machine; null = the machine's default login. */
  configDir: string | null;
  /** Who is logged in there, read from Claude Code's own config on that machine. */
  email: string | null;
  organization: string | null;
  /** Whose models it talks to; absent or null: not known yet (taken as Anthropic's). */
  provider?: AccountProvider | null;
  endpoint?: string | null;
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  /**
   * The week of one model — the allowance a subscription has for its strongest model apart from the week for all
   * models — by the model's family ("fable", "opus"…). From Claude Code's own report where it gives one
   * (`reported`), or from a turn it refused for that limit (`refused`: used up, until the time it named or the
   * office's best guess). Absent: nothing is known about any.
   */
  modelWeeks?: Record<string, LimitWindow & { from: 'reported' | 'refused' }>;
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

/**
 * The places an office can stand in (`OwnerSettings.surroundings`). Each is a scene of its own around the same
 * building — `packages/office-3d/src/surroundings/`, `docs/SURROUNDINGS.md`.
 */
export const SURROUNDINGS = ['studio', 'skyline', 'park', 'island', 'north', 'orbit'] as const;
export type Surroundings = (typeof SURROUNDINGS)[number];
/** What a stored value means: one of the places, or the plain one for anything else. */
export function surroundingsOf(value: unknown): Surroundings {
  return (SURROUNDINGS as readonly unknown[]).includes(value) ? (value as Surroundings) : 'studio';
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
   * true (default — the owner's word of 2026-11-13: "agents should be able to change models and effort for
   * themselves or other agents, so that e.g. the project manager can put the others on a cheaper model when the
   * work does not need the most expensive"): an employee may set the model and the effort of their own and of a
   * colleague's sessions (the `set_model` tool), each change on the record with its reason. Not the level, not the
   * account, not across to or from a member's own computer, never the foreman. false: those stay the owner's.
   */
  employeesSetModels?: boolean;
  /** Who reviews a finished task when nobody chose for it (`reviewDefaultOf`: a colleague, then the boss). */
  reviewDefault?: ReviewBy;
  /**
   * true (default): on machines where a browser for employees is installed, every session gets it as tools of its own
   * (open a page, click, read it, take a screenshot). false: no session gets it.
   */
  employeesBrowser?: boolean;
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
  /**
   * The same for employees on `unrestricted` (Claude Code's bypass mode, where the office itself holds such a command
   * until the owner answers). false: an Unrestricted employee is never stopped for approval — what it runs, runs.
   * Not set: as `autoAsksHighRisk` says (how it was before this switch existed). The office's own files on a machine
   * stay fenced off either way.
   */
  unrestrictedAsksHighRisk?: boolean;
  /**
   * The release gate (docs/RELEASE-GATE.md): on, nothing reaches the protected branches or a production server before
   * an owner approved the work. Absent: off. Read with `releaseRulesOf`.
   */
  releaseGate?: { on?: boolean; branches?: string[]; hosts?: string[] } | null;
  /**
   * Claude Code's own questions at the start of a session are answered "yes" by the office itself — the owner's
   * decision of 2026-11-13 ("make it say yes and trust the folder by itself instead of getting stuck", and of the
   * warning about running without permission checks: "this too should pass by itself"):
   *  - **the workspace-trust question** for the folder an employee was put in, whatever their level;
   *  - **the Bypass Permissions warning** for an employee an owner put on Unrestricted, on the office's own machines.
   * Each is on the record (audit and feed). Not set or true: answered by the office. false: as before this switch —
   * the trust question is answered only for employees on Auto and Unrestricted, and the warning is the owner's to
   * accept in the office.
   */
  acceptStartPrompts?: boolean;
  /**
   * Where the office stands: what is seen around the building, from above and through its windows. The office's own
   * (the same for everybody in it), chosen by an owner. Not set: `studio`, the building by itself in the dark, as it
   * was before there was a choice.
   */
  surroundings?: Surroundings;
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
