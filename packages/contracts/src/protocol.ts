import type {
  AgentSession,
  Artifact,
  AuditEntry,
  CollabRequest,
  CompanyStats,
  ControlState,
  Employee,
  Host,
  HostInfo,
  HostResources,
  ID,
  Improvement,
  Lesson,
  Meeting,
  Message,
  Milestone,
  Notification,
  OfficeLayout,
  OwnerSettings,
  PerformanceStat,
  Project,
  RadioNow,
  RentFence,
  ServiceProvider,
  Question,
  Routine,
  SessionCapabilities,
  SessionOrigin,
  ExecutionMode,
  SessionUsage,
  Task,
  XpEntry,
} from './entities.ts';
import type { OrchestratorEvent, RawHookEvent } from './events.ts';
import type { ContextPack } from './context.ts';
import type { ArcadeButton, ArcadeGame, ArcadeMediaKind, ArcadeTable } from './arcade.ts';

export const PROTOCOL_VERSION = 1;

// ─────────────────────── Terminal payloads ───────────────────────

/** Low-rate plain capture of a pane, used for in-world monitor textures. */
export interface TerminalScreen {
  cols: number;
  rows: number;
  /** Visible lines including SGR colour escapes (tmux capture-pane -e). */
  lines: string[];
  cursor: { x: number; y: number; visible: boolean };
  ts: string;
  /** Changes whenever the visible content changes. */
  hash: string;
}

/** Full-fidelity snapshot that primes an xterm.js instance before streaming. */
export interface TerminalSnapshot {
  sessionId: ID;
  cols: number;
  rows: number;
  /** base64 of the bytes to write into a freshly reset terminal. */
  data: string;
  /** Output sequence number the snapshot is consistent with. */
  seq: number;
}

// ─────────────────────── Host agent ⇄ server ─────────────────────

/**
 * The version of the commands Claude Code runs for a session's hooks (written into the session's settings when it is
 * started; a running session keeps the ones it has). 2: a deciding hook tries again while the machine's agent is
 * being restarted, and in bypass mode a command nobody could look at is refused.
 */
export const HOOKS_VERSION = 2;

export interface AgentSessionReport {
  sessionId: ID;
  /** The launch this report is about (see LaunchSpec.launchId). Absent for attached sessions. */
  launchId?: string | null;
  origin: SessionOrigin;
  mode: ExecutionMode;
  tmuxSession: string;
  tmuxPane: string | null;
  cwd: string;
  repoRoot: string | null;
  branch: string | null;
  pid: number | null;
  alive: boolean;
  command: string | null;
  cols: number;
  rows: number;
  claudeSessionId: string | null;
  capabilities: SessionCapabilities;
  permissionMode: string | null;
  /** Which version of the hook commands this session was started with (`HOOKS_VERSION`); absent from an agent that does not say. */
  hooksVersion?: number;
  model: string | null;
  startedAt: string;
  exitReason: string | null;
}

/** Everything the agent needs to launch a managed Claude Code worker. */
export interface LaunchSpec {
  /**
   * Issued by the server for every start. A session keeps its id (and tmux name) across restarts,
   * so this is what tells one incarnation from the next: reports about an older launch are ignored.
   */
  launchId?: string;
  displayName: string;
  cwd: string;
  mode: ExecutionMode;
  model: string | null;
  /** `claude --effort <level>`; the agent passes it only when its Claude Code has that level. */
  effort?: string | null;
  permissionMode: string;
  permissions: { allow: string[]; deny: string[]; ask: string[] };
  allowedTools: string[];
  disallowedTools: string[];
  appendSystemPrompt: string;
  /** Orchestrator MCP endpoint + bearer token scoped to this session. */
  mcp: { url: string; token: string } | null;
  /** Load only the MCP servers given here, ignoring the user's and the project's own. */
  strictMcp: boolean;
  /** Regexes for shell commands that must always go through an approval. */
  highRiskPatterns: string[];
  /** Fixed Claude session id so the conversation can be resumed after a crash. */
  claudeSessionId: string;
  resume: boolean;
  /** Further directories the session may read and change (other repositories of the same project). */
  addDirs?: string[];
  /** Give the session this machine's browser tools, if it has them (see `HostInfo.browser`). */
  browser?: boolean;
  /** Start by continuing the latest conversation Claude Code already has in this folder, instead of a new one. */
  continueLast?: boolean;
  /** A rented employee: the folders they may reach and what they may do there (`docs/RENT.md`). Changed live with `session.fence`. */
  fence?: RentFence | null;
  /** The central context this employee holds (`docs/CONTEXT.md`); changed live with `session.context`. */
  context?: ContextPack | null;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type AgentRpc =
  | { method: 'session.create'; params: { sessionId: ID; spec: LaunchSpec } }
  | { method: 'session.attach'; params: { sessionId: ID; tmuxSession: string; tmuxPane?: string | null } }
  | { method: 'session.detach'; params: { sessionId: ID } }
  | { method: 'session.kill'; params: { sessionId: ID } }
  | { method: 'session.interrupt'; params: { sessionId: ID } }
  | { method: 'session.paste'; params: { sessionId: ID; text: string; submit: boolean } }
  | { method: 'session.keys'; params: { sessionId: ID; keys: string[] } }
  /** The owner allowed one exact tool call that Claude Code had refused: the next identical call from this session is let through, once, within `ttlMs`. */
  | { method: 'session.grant'; params: { sessionId: ID; tool: string; input: unknown; ttlMs: number } }
  | { method: 'session.fence'; params: { sessionId: ID; fence: RentFence | null } }
  | { method: 'session.context'; params: { sessionId: ID; context: ContextPack | null } }
  | { method: 'term.subscribe'; params: { sessionId: ID } }
  | { method: 'term.unsubscribe'; params: { sessionId: ID } }
  | { method: 'term.input'; params: { sessionId: ID; data: string } }
  | { method: 'term.resize'; params: { sessionId: ID; cols: number; rows: number } }
  | { method: 'term.history'; params: { sessionId: ID; lines: number } }
  | { method: 'tmux.discover'; params: Record<string, never> }
  | { method: 'proc.claude'; params: Record<string, never> }
  | { method: 'fs.inspect'; params: { path: string } }
  /** Claude accounts of this machine's user: for each config folder, is anybody logged in there, and who. `prepare`: make the folder (and let it share the conversations of the default one) so that it only needs a login. */
  | { method: 'claude.accounts'; params: { dirs: Array<string | null>; prepare?: boolean } }
  /**
   * Signing in to a Claude account from the office: `start` runs Claude Code's own sign-in for that folder in a
   * terminal of its own on the machine, `screen` says what it shows, `input` types into it (a line of text — the code
   * the sign-in page gives — or one named key), `stop` ends it. Answers with `AccountLogin`.
   */
  | { method: 'claude.login'; params: { op: 'start' | 'screen' | 'input' | 'stop'; dir: string | null; text?: string; key?: string; email?: string } }
  /** Make a config folder an account of another service (Z.AI): its address and key go into that folder's own settings, on the machine. Answers with `{ account: AccountInfo }`. */
  | { method: 'claude.provider'; params: { dir: string; provider: ServiceProvider; token: string; baseUrl?: string; models?: { opus?: string; sonnet?: string; haiku?: string } } }
  /** A piece of a file for an employee on this machine (a task's attachment). Kept in the agent's own folder; answers with its path there. */
  | { method: 'files.put'; params: { folder: string; name: string; offset: number; dataBase64: string; last: boolean } }
  /** A piece of a file an employee on this machine leaves as evidence. Read only from the allowed roots, the agent's own folders and the temp folder. */
  | { method: 'files.get'; params: { path: string; cwd?: string | null; sessionId?: ID | null; offset: number; length: number } }
  | { method: 'fs.browse'; params: { path?: string | null } }
  /** Make one new, empty folder inside an existing one of the allowed roots (for an employee about to be hired into it). */
  | { method: 'fs.mkdir'; params: { parent: string; name: string } }
  | { method: 'fs.docs.list'; params: { cwd: string } }
  | { method: 'fs.docs.read'; params: { cwd: string; path: string } }
  | { method: 'git.status'; params: { cwd: string } }
  | { method: 'git.diff'; params: { cwd: string; base?: string | null; maxBytes?: number } }
  | { method: 'git.log'; params: { cwd: string; range: string; max?: number } }
  | { method: 'git.worktree.ensure'; params: { repo: string; path: string; branch: string; base: string } }
  | { method: 'git.branch.start'; params: { cwd: string; branch: string; base: string } }
  /** Commit what is uncommitted in a worktree on its (task) branch as work in progress — when a task is stopped. */
  | { method: 'git.wip'; params: { cwd: string; branch: string; message: string } }
  // `sha`: the commit of `branch` to merge (the one that was verified); commits made on the branch after it stay out.
  | { method: 'git.merge'; params: { repo: string; worktree: string; into: string; base: string; branch: string; message: string; sha?: string | null } }
  | { method: 'git.integration.status'; params: { repo: string; base: string; integration: string } }
  | { method: 'git.promote'; params: { repo: string; base: string; integration: string } }
  | { method: 'verify.run'; params: { cwd: string; command: string; timeoutMs: number } }
  | { method: 'usage.read'; params: { sessionId: ID } }
  | { method: 'claude.headless'; params: { cwd: string; prompt: string; jsonSchema?: unknown; timeoutMs: number } };

export type AgentRpcMethod = AgentRpc['method'];

export type AgentToServer =
  | {
      t: 'hello';
      protocol: number;
      hostId?: string | null;
      credential?: string | null;
      enrollmentToken?: string | null;
      /** Only exchange the enrollment token for a credential; do not come online. */
      enrollOnly?: boolean;
      name?: string | null;
      info: HostInfo;
    }
  | { t: 'sessions'; sessions: AgentSessionReport[] }
  | { t: 'session'; session: AgentSessionReport }
  | { t: 'session.gone'; sessionId: ID; reason: string; /** Which launch ended (see LaunchSpec.launchId). */ launchId?: string | null }
  | { t: 'hook'; event: RawHookEvent }
  | { t: 'hook.request'; requestId: string; event: RawHookEvent }
  | { t: 'hook.settled'; requestId: string; outcome: 'delivered' | 'abandoned'; detail?: string }
  | { t: 'term.output'; sessionId: ID; seq: number; data: string }
  | { t: 'term.screen'; sessionId: ID; screen: TerminalScreen }
  | { t: 'resources'; resources: HostResources }
  | { t: 'usage'; sessionId: ID; usage: SessionUsage }
  /**
   * The shells Claude Code started for commands of this session that are alive right now (the one running in front of
   * it as well: the office tells them apart from its hooks). Sent when the set changes, and once for every session
   * when the agent (re)connects. `seconds`: how long each has been running.
   */
  | { t: 'shells'; sessionId: ID; shells: Array<{ pid: number; command: string; seconds: number }> }
  /** What Claude Code's status line said about the account's rate limits, and whose account it is. */
  | { t: 'limits'; sessionId: ID; configDir: string | null; email: string | null; organization: string | null; fiveHour: { usedPercent: number; resetsAt: string | null } | null; sevenDay: { usedPercent: number; resetsAt: string | null } | null; /** Every other window Claude Code gave, under its own name (`seven_day_fable`…). */ windows?: Record<string, { usedPercent: number; resetsAt: string | null }> }
  | { t: 'rpc.result'; id: string; ok: boolean; result?: unknown; error?: string }
  | ({ t: 'request'; id: string } & AgentRequest)
  | { t: 'pong' };

/** Requests a host makes on behalf of its local operator (the orchestrator-agent CLI). */
export type AgentRequest =
  | { method: 'bind'; params: { sessionId: ID; employee: string | null; role?: string | null } }
  | { method: 'create'; params: { name: string; project: string; role: string | null; model?: string | null; autonomy?: string | null } }
  | { method: 'status'; params: Record<string, never> };

export type ServerToAgent =
  | { t: 'welcome'; hostId: string; credential?: string; serverTime: string; name: string }
  | { t: 'rejected'; reason: string }
  | { t: 'ack'; ids: string[] }
  | { t: 'hook.response'; requestId: string; output: Record<string, unknown> | null }
  | ({ t: 'rpc'; id: string } & AgentRpc)
  | { t: 'response'; id: string; ok: boolean; result?: unknown; error?: string }
  | { t: 'ping' };

// ───────────────────────── UI ⇄ server ───────────────────────────

export interface FullState {
  serverTime: string;
  settings: OwnerSettings;
  layout: OfficeLayout;
  hosts: Host[];
  employees: Employee[];
  sessions: AgentSession[];
  projects: Project[];
  tasks: Task[];
  questions: Question[];
  messages: Message[];
  collabs: CollabRequest[];
  notifications: Notification[];
  meetings: Meeting[];
  artifacts: Artifact[];
  milestones: Milestone[];
  company: CompanyStats;
  lessons: Lesson[];
  improvements: Improvement[];
  performance: PerformanceStat[];
  /** Standing instructions the office repeats for employees. */
  routines: Routine[];
  events: OrchestratorEvent[];
}

export type EntityKind =
  | 'host'
  | 'employee'
  | 'session'
  | 'project'
  | 'task'
  | 'question'
  | 'message'
  | 'collab'
  | 'notification'
  | 'meeting'
  | 'artifact'
  | 'milestone'
  | 'settings'
  | 'layout'
  | 'company'
  | 'lesson'
  | 'improvement'
  | 'performance'
  | 'routine';

export type ClientToServer =
  | { t: 'term.open'; sessionId: ID }
  | { t: 'term.close'; sessionId: ID }
  | { t: 'term.input'; sessionId: ID; data: string }
  | { t: 'term.resize'; sessionId: ID; cols: number; rows: number }
  /** Somebody watching has a window wider than the pane: make the pane as wide (never narrower). */
  | { t: 'term.widen'; sessionId: ID; cols: number; rows: number }
  | { t: 'control.observe'; sessionId: ID }
  | { t: 'control.acquire'; sessionId: ID }
  | { t: 'control.release'; sessionId: ID }
  | { t: 'screens.focus'; sessionId: ID | null }
  /** Where this person's character is, so the others in the office can see them. */
  | { t: 'presence'; x: number; z: number; rot: number; moving: boolean; at?: number; sit?: boolean }
  /** This person's character jumped (the interact key with nothing to act on in front of them): everyone sees it. */
  | { t: 'jump' }
  /** Something said out loud to the other people in the office (not to employees). */
  | { t: 'say'; text: string }
  /**
   * Cracking the whip: at an employee, or at another person standing next to one (`personId`: their window).
   * Everyone in the office sees it. At an employee who is waiting for a permission it also approves that request —
   * when the office's owners switched that on (`OwnerSettings.whipApproves`) and this person may decide it.
   */
  | { t: 'whip'; employeeId?: string; personId?: string }
  /** A gesture of this person's character (the wheel): everyone in the office sees it. */
  | { t: 'emote'; name: EmoteName }
  /**
   * A frame of this person's voice while they hold the talk key: 40 ms of 16 kHz mono, one byte a sample (µ-law),
   * as base64. Passed on to those within earshot (the server's `voice.ts`) and kept nowhere.
   */
  | { t: 'voice'; seq: number; data: string }
  /** They let go of the talk key. */
  | { t: 'voice.end' }
  /** The arcade: let the office in on the game this window is playing (a table), or end that. */
  | { t: 'arcade.open'; title: string; gameId: string | null }
  | { t: 'arcade.close' }
  /** Sit down at somebody's table: with the second pad, or to look on. And get up again. */
  | { t: 'arcade.join'; table: string; as: 'player' | 'watch' }
  | { t: 'arcade.leave' }
  /** From a table's host: a piece of its picture or sound, passed on to those at the table and kept nowhere. */
  | { t: 'arcade.media'; kind: ArcadeMediaKind; key?: boolean; ts: number; data: string }
  /** From whoever holds the second pad at a table: a button pressed or let go. */
  | { t: 'arcade.pad'; button: ArcadeButton; down: boolean }
  /** From somebody at a table: the picture broke up, send one that stands by itself. */
  | { t: 'arcade.key' }
  | { t: 'ping' };

/** What a person's character can do on request (the gesture wheel), in the order the wheel shows them. */
export const EMOTES = ['wave', 'dance', 'clap', 'thumbsUp', 'shrug', 'point', 'cheer', 'bow'] as const;
export type EmoteName = (typeof EMOTES)[number];
export const isEmote = (name: unknown): name is EmoteName => typeof name === 'string' && (EMOTES as readonly string[]).includes(name);

/** Who a connected person is: the owner, or a guest with a role. */
export interface Me {
  /** 'owner': full rights (the root owner on the server machine, or a member with the role owner). 'guest': a colleague or visitor. */
  kind: 'owner' | 'guest';
  role: 'owner' | 'colleague' | 'visitor';
  name: string;
  /** The member's id; 'owner' for the root owner. Personal hosts with this `memberId` are this person's. */
  id?: string;
}

/** A person present in the office right now (one entry per open window). */
export interface PersonPresence {
  id: string;
  name: string;
  role: Me['role'];
  /** Whose window this is: the member's id ('owner' for the root owner). */
  memberId?: string;
  x: number;
  z: number;
  rot: number;
  moving: boolean;
  /** The sender's own clock at that report (ms): the others draw the walk evenly by it. */
  at?: number;
  /** They are sitting (on a sofa, a chair): `x`, `z` and `rot` are the seat's. */
  sit?: boolean;
  hue: number;
}

/** Someone at the office's door, asking to be let in (see the server's `knocks.ts`). */
export interface KnockView {
  id: string;
  name: string;
  /** 'browser': the office's page in a browser — they can only be let in to look. 'app': the desktop app. */
  via: 'browser' | 'app';
  /** Four digits the person at the door sees too. */
  code: string;
  at: string;
}

/** Who said or did something in the office chat: their window, name, role and the colour their character wears. */
export interface ChatFrom {
  id: string;
  name: string;
  role: Me['role'];
  hue?: number;
}

export type ServerToClient =
  /** `showcase`: the public demo office, where visitors only watch (`docs/DEMO.md`). */
  | { t: 'ready'; clientId: string; state: FullState; me: Me; showcase?: boolean }
  | { t: 'people'; people: PersonPresence[] }
  /** Who is at the door right now (sent to those who may let someone in: owners and colleagues). */
  | { t: 'knocks'; knocks: KnockView[] }
  /** What the office's hi-fi is playing (null: it is off). Sent to everyone when they come in and whenever it changes. */
  | { t: 'radio'; radio: RadioNow | null }
  | { t: 'said'; from: ChatFrom; text: string; ts: string }
  /** What was said in the office lately, for someone who has just walked in. */
  | { t: 'chat.history'; lines: Array<{ from: ChatFrom; text: string; ts: string; emote?: boolean }> }
  /**
   * Someone cracked the whip: at an employee, or at another person (`personId`: that person's window).
   * `approved`: how many permission requests of that employee the crack approved (absent: none).
   */
  | { t: 'whipped'; from: ChatFrom; employeeId?: string; personId?: string; approved?: number; woke?: boolean; ts: string }
  /** Someone's character jumped (`from`: their window). */
  | { t: 'jumped'; from: string }
  /** Someone's character made a gesture. */
  | { t: 'emoted'; from: ChatFrom; name: EmoteName; ts: string }
  /** A frame of someone's voice (`from`: their window), sent only to those within earshot. */
  | { t: 'voice'; from: string; seq: number; data: string }
  /** They stopped talking. */
  | { t: 'voice.end'; from: string }
  /** The arcade as it stands: the games on the shelf and the tables that are open. Sent at the start and whenever either changes. */
  | { t: 'arcade'; games: ArcadeGame[]; tables: ArcadeTable[] }
  /** To those at a table: a piece of the host's picture or sound. */
  | { t: 'arcade.media'; table: string; kind: ArcadeMediaKind; key?: boolean; ts: number; data: string }
  /** To a table's host: the second pad's button, from whoever holds it. */
  | { t: 'arcade.pad'; button: ArcadeButton; down: boolean }
  /** To a table's host: somebody sat down (send them how to read the picture, and one that stands by itself) or asked for such a picture. */
  | { t: 'arcade.key'; to: string }
  /** To somebody at a table: it is over (the host stopped, or left the office). */
  | { t: 'arcade.closed'; table: string }
  | { t: 'entity'; kind: EntityKind; op: 'upsert' | 'remove'; data: any }
  | { t: 'event'; event: OrchestratorEvent }
  | { t: 'term.snapshot'; snapshot: TerminalSnapshot }
  | { t: 'term.output'; sessionId: ID; seq: number; data: string }
  | { t: 'term.screen'; sessionId: ID; screen: TerminalScreen }
  | { t: 'term.closed'; sessionId: ID; reason: string }
  | { t: 'control'; sessionId: ID; control: ControlState; controllerId: string | null; you: boolean }
  | { t: 'error'; message: string; ref?: string }
  | { t: 'pong' };

// ───────────────────── Natural-language commands ─────────────────

/** An explicit, validated operation produced from an owner instruction. */
export type Operation =
  | { op: 'task.create'; projectId: ID | null; title: string; description: string; assigneeId: ID | null; roleHint: string | null; kind: Task['kind']; priority: Task['priority']; start: boolean }
  | { op: 'task.assign'; taskId: ID; assigneeId: ID }
  | { op: 'employee.message'; employeeId: ID; body: string }
  | { op: 'employee.pause'; employeeId: ID }
  | { op: 'employee.resume'; employeeId: ID }
  | { op: 'employee.report'; employeeId: ID }
  | { op: 'project.pause'; projectId: ID }
  | { op: 'project.resume'; projectId: ID }
  | { op: 'project.move_team'; fromProjectId: ID; toProjectId: ID }
  | { op: 'project.plan'; projectId: ID; objective: string; plannerId: ID }
  | { op: 'meeting.create'; projectId: ID | null; topic: string; participantIds: ID[]; facilitatorId: ID }
  | { op: 'query.attention' }
  | { op: 'query.available'; role: string | null }
  | { op: 'query.summary'; since: string | null }
  | { op: 'ui.focus'; employeeId: ID };

export interface CommandPlan {
  input: string;
  interpretedBy: 'rules' | 'claude-headless';
  operations: Array<{ operation: Operation; description: string }>;
  /** Anything we could not resolve; a non-empty list means nothing is executed. */
  problems: string[];
}

export interface CommandResult {
  executed: Array<{ description: string; ok: boolean; detail: string; ref?: { kind: EntityKind; id: ID } }>;
  /** Present for query operations. */
  answer?: { title: string; lines: string[]; employeeIds?: ID[] };
}

export type { AuditEntry, XpEntry };
