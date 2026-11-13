import { EventEmitter } from 'node:events';
import type {
  AgentRpc,
  AgentSession,
  Artifact,
  CollabRequest,
  CompanyStats,
  Employee,
  EntityKind,
  ForemanSettings,
  EventType,
  Host,
  Improvement,
  Lesson,
  Meeting,
  Message,
  Milestone,
  Notification,
  OfficeLayout,
  OrchestratorEvent,
  OwnerSettings,
  Project,
  Question,
  SelfImprovementSettings,
  Routine,
  Task,
  XpEntry,
  EventSourceKind,
} from '@orchestrator/contracts';
import { REVIEW_BY, SURROUNDINGS, defaultLayout, newId, nowIso } from '@orchestrator/contracts';
import type { Collection, Storage } from '@orchestrator/database';
import { deriveCompanyStats, emptyCompanyStats, initialMilestones } from '@orchestrator/game-systems';
import type { TerminalGateway } from '@orchestrator/terminal';

/** How the engine reaches host agents. Implemented by the server's agent hub. */
export interface AgentLink {
  rpc<T = any>(hostId: string, rpc: AgentRpc, timeoutMs?: number): Promise<T>;
  isOnline(hostId: string): boolean;
  respondHook(hostId: string, requestId: string, output: Record<string, unknown> | null): boolean;
  disconnect(hostId: string, reason: string): void;
}

export interface Timings {
  /** How long an ask_boss / wait_for_answer tool call blocks before returning "not answered yet". */
  askBossWaitMs: number;
  /** How long a tool call that waits for a colleague (their answer, or the end of a task) blocks before returning "not yet". */
  colleagueWaitMs: number;
  /** While someone waits for a colleague: how long that colleague may be without a session (it is being moved or started) before the wait is cut short. */
  waitGoneGraceMs: number;
  /** How long each meeting round waits for contributions. */
  meetingRoundMs: number;
  /** Delay between a session becoming idle and Orchestrator typing into it. */
  deliverySettleMs: number;
  /** A pasted prompt that no hook confirmed is considered unconfirmed after this long. */
  deliveryConfirmMs: number;
  /** How long a permission prompt must stand in a terminal, unasked, before the office asks about it itself. */
  terminalPromptMs?: number;
  /** How long a held question waits for its machine to come back still holding it: after the office starts or the machine is lost… */
  hookRejoinMs?: number;
  /** …and after the machine has reported in again (what it still holds arrives right behind its report). */
  hookRejoinGraceMs?: number;
  /** Default verification command timeout. */
  verifyTimeoutMs: number;
  scheduleDebounceMs: number;
  /** How often the office looks at what would need the foreman (no model involved). */
  foremanTickMs: number;
  /** A question or a ready task must have waited this long before it calls the foreman. */
  foremanSettleMs: number;
  /** Idle with a task in progress for this long counts as stalled. */
  foremanStalledMs: number;
  /** Overrides the owner's "idle for … minutes" setting (tests run on faster clocks). */
  foremanIdleMs: number | null;
  /** Someone has waited this long for a colleague who has been doing nothing for as long: the foreman is called. */
  foremanWaitingMs: number;
  /** How long records wait before the long memory files them (one run for everything that came in meanwhile). */
  memoryMineDelayMs?: number;
  /** How long a task's hand-over waits for the long memory before going without it. */
  memoryRecallMs?: number;
  /** How often the office looks for employees on a Claude account that has run out. */
  accountFailoverMs?: number;
  /** The shortest gap between two foreman rounds, whatever the owner's setting says. */
  foremanMinGapMs: number;
  /** A round that was neither finished nor ended with its turn is given up on after this long. */
  foremanRoundTimeoutMs: number;
  /** autopilot (trusted): approvals of one command shape, with no denial, before its allow rule is applied by itself. */
  autopilotAllowApprovals: number;
  /** autopilot (trusted): those approvals must span at least this long, unless they come from two different tasks. */
  autopilotAllowSpreadMs: number;
  /** autopilot (trusted): the project's last this-many reviewed tasks must all have been approved first time before review is switched off by itself. */
  autopilotReviewOffTasks: number;
  /** autopilot: a change the office made by itself is on probation for this long… */
  autopilotProbationMs: number;
  /** …or until this many tasks of the affected project or employee have finished, whichever comes first. */
  autopilotProbationTasks: number;
  /** How often the office looks for routines that are due. */
  routineTickMs: number;
  /** How long "a minute" of a routine's interval is (tests run on faster clocks). */
  routineMinuteMs: number;
  /** How often the office looks for sessions that have sat idle long enough to be put to sleep. */
  sleepTickMs: number;
  /** How often the time each employee works is added up (`WorkLog`). */
  workTickMs: number;
  /** Overrides the owner's "asleep after … minutes" setting (tests run on faster clocks). */
  sleepIdleMs: number | null;
  /** After a session that would not start when it was needed: no further attempt for this long. */
  wakeRetryMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  askBossWaitMs: 240_000,
  colleagueWaitMs: 240_000,
  waitGoneGraceMs: 5000,
  meetingRoundMs: 8 * 60_000,
  deliverySettleMs: 350,
  deliveryConfirmMs: 20_000,
  verifyTimeoutMs: 240_000,
  scheduleDebounceMs: 120,
  foremanTickMs: 5000,
  foremanSettleMs: 4000,
  foremanStalledMs: 5 * 60_000,
  foremanIdleMs: null,
  foremanWaitingMs: 2 * 60_000,
  foremanMinGapMs: 30_000,
  foremanRoundTimeoutMs: 10 * 60_000,
  autopilotAllowApprovals: 5,
  autopilotAllowSpreadMs: 24 * 3600_000,
  autopilotReviewOffTasks: 10,
  autopilotProbationMs: 7 * 86400_000,
  autopilotProbationTasks: 5,
  routineTickMs: 20_000,
  routineMinuteMs: 60_000,
  sleepTickMs: 30_000,
  workTickMs: 30_000,
  sleepIdleMs: null,
  wakeRetryMs: 30_000,
};

export interface EngineOptions {
  store: Storage;
  agents: AgentLink;
  /** Base URL workers use to reach the Orchestrator MCP endpoint. */
  publicUrl: string;
  timings?: Partial<Timings>;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Where the vault's key is kept (a file made on first use). Without it, what the vault holds lasts until the process ends. */
  vaultKeyFile?: string | null;
  /** Where the files attached to tasks are kept. Absent: the office keeps none. */
  filesDir?: string | null;
  /** The long memory: the `mempalace` program and the folder its records live in. Absent: none. */
  memory?: { bin: string | null; dir: string | null };
}

export interface BusEvents {
  entity: [kind: EntityKind, op: 'upsert' | 'remove', data: any];
  event: [event: OrchestratorEvent];
  /** Something in the vault changed (what, is asked for by whoever may know). */
  vault: [];
}

/** TV bookmarks come from the owner's typing: http(s) addresses with a name, bounded. */
export function sanitizeTv(input: Partial<OwnerSettings['tv']>, current: OwnerSettings['tv']): OwnerSettings['tv'] {
  const web = (u: unknown): string | null => (typeof u === 'string' && /^https?:\/\/[^\s<>"']+$/i.test(u.trim()) && u.length <= 500 ? u.trim() : null);
  const bookmarks = Array.isArray(input.bookmarks)
    ? input.bookmarks
        .map((b) => ({ name: String(b?.name ?? '').trim().slice(0, 40), url: web(b?.url) }))
        .filter((b): b is { name: string; url: string } => !!b.name && !!b.url)
        .slice(0, 30)
    : current.bookmarks;
  return { home: web(input.home) ?? current.home, bookmarks };
}

/** Stations come from the owner's typing: keep only well-formed http(s) streams, bounded in number and length. */
export function sanitizeRadio(input: Partial<OwnerSettings['radio']>, current: OwnerSettings['radio']): OwnerSettings['radio'] {
  const web = (u: unknown): string | null => (typeof u === 'string' && /^https?:\/\/[^\s<>"']+$/i.test(u.trim()) && u.length <= 500 ? u.trim() : null);
  const stations = Array.isArray(input.stations)
    ? input.stations
        .map((s) => ({ id: String(s?.id ?? '').slice(0, 64), name: String(s?.name ?? '').trim().slice(0, 80), url: web(s?.url), nowPlayingUrl: web(s?.nowPlayingUrl), page: web(s?.page) }))
        .filter((s): s is { id: string; name: string; url: string; nowPlayingUrl: string | null; page: string | null } => !!s.id && !!s.name && !!s.url)
        .slice(0, 60)
    : current.stations;
  const volume = typeof input.volume === 'number' && Number.isFinite(input.volume) ? Math.min(1, Math.max(0, input.volume)) : current.volume;
  const last = input.lastStationId === undefined ? current.lastStationId : input.lastStationId;
  return { stations, volume, lastStationId: last && stations.some((s) => s.id === last) ? last : null };
}

/**
 * Foreman settings come from the owner's typing: booleans stay booleans and the two intervals are
 * whole numbers inside sane bounds. `minGapFloorSeconds` is the shortest gap the office allows.
 */
export function sanitizeForeman(input: unknown, current: ForemanSettings, minGapFloorSeconds = 30): ForemanSettings {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback);
  const quiet = int(i.quietCheckMinutes, 0, 24 * 60, current.quietCheckMinutes);
  return {
    enabled: typeof i.enabled === 'boolean' ? i.enabled : current.enabled,
    minGapSeconds: int(i.minGapSeconds, minGapFloorSeconds, 3600, Math.max(minGapFloorSeconds, current.minGapSeconds)),
    // 0 switches quiet checks off; anything else is at least five minutes.
    quietCheckMinutes: quiet === 0 ? 0 : Math.max(5, quiet),
    answersQuestions: typeof i.answersQuestions === 'boolean' ? i.answersQuestions : current.answersQuestions,
    // 0 switches it off; settings stored before this existed get the default.
    idleMinutes: int(i.idleMinutes, 0, 24 * 60, current.idleMinutes ?? 10),
  };
}

/** The autopilot's dial and its daily limit come from the owner's typing: one of three words, and a whole number from 1 to 20. */
export function sanitizeAutopilot(si: SelfImprovementSettings, fallback: Pick<SelfImprovementSettings, 'autopilot' | 'autopilotMaxPerDay'>): SelfImprovementSettings {
  const n = si.autopilotMaxPerDay;
  return {
    ...si,
    autopilot: si.autopilot === 'off' || si.autopilot === 'safe' || si.autopilot === 'trusted' ? si.autopilot : fallback.autopilot,
    autopilotMaxPerDay: typeof n === 'number' && Number.isFinite(n) ? Math.min(20, Math.max(1, Math.round(n))) : fallback.autopilotMaxPerDay,
  };
}

/** Minutes without work before a session is put to sleep: 0 switches it off; anything else is five minutes to a day. */
export function sanitizeSleep(input: unknown, current: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return current;
  const n = Math.round(input);
  return n <= 0 ? 0 : Math.min(24 * 60, Math.max(5, n));
}

const DEFAULT_SETTINGS: OwnerSettings = {
  companyName: 'My Company',
  ownerName: 'Boss',
  gamification: true,
  nlFallback: false,
  workersInheritMcp: false,
  employeesManageBoard: true,
  employeesBrowser: true,
  longMemory: true,
  accountFailover: true,
  whipApproves: false,
  autoAsksHighRisk: true,
  projectZones: false,
  approachZoom: false,
  sleepAfterMinutes: 30,
  tv: {
    home: 'https://www.youtube.com/',
    bookmarks: [
      { name: 'YouTube', url: 'https://www.youtube.com/' },
      { name: 'YouTube Music', url: 'https://music.youtube.com/' },
      { name: 'SoundCloud', url: 'https://soundcloud.com/' },
      { name: 'Search', url: 'https://duckduckgo.com/' },
    ],
  },
  radio: {
    stations: [{ id: 'mansionnet', name: 'MansionNET Radio', url: 'https://radio.inthemansion.com/listen/mansionnet/radio.mp3', nowPlayingUrl: 'https://radio.inthemansion.com/api/nowplaying/mansionnet', page: 'https://radio.inthemansion.com/public/mansionnet' }],
    volume: 0.6,
    lastStationId: null,
  },
  selfImprovement: { enabled: true, retrospectives: 'friction', autoApproveSharedLessons: false, learnedRouting: true, outcomesAutoRetire: true, autopilot: 'safe', autopilotMaxPerDay: 3 },
  foreman: { enabled: false, minGapSeconds: 120, quietCheckMinutes: 15, answersQuestions: true, idleMinutes: 10 },
  quality: 'high',
  keybindings: {
    forward: 'KeyW',
    back: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
    strafeLeft: 'KeyQ',
    strafeRight: 'KeyE',
    interact: 'Space',
    talk: 'KeyF',
    whip: 'KeyR',
    overview: 'Tab',
    map: 'KeyM',
    tasks: 'KeyT',
    projects: 'KeyP',
    notifications: 'KeyN',
    command: 'KeyG',
    camera: 'KeyC',
    exit: 'Escape',
  },
  lastSeenAt: null,
};

export class EngineError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Is every text of a change no longer than it may be? `limits`: field → the most characters (a list: the most items,
 * each of them a text of at most `itemMax`). A field that is absent, or not a text or list, is not looked at here.
 * Text that is kept is read again and again by the office's own patterns and shown in every window; one field of a
 * megabyte is a way to slow all of that down.
 */
export function within(input: Record<string, unknown> | undefined | null, limits: Record<string, number>, itemMax = 400): void {
  for (const [field, max] of Object.entries(limits)) {
    const v = input?.[field];
    if (typeof v === 'string' && v.length > max) throw new EngineError(`"${field}" is too long (${v.length.toLocaleString('en-US')} characters; at most ${max.toLocaleString('en-US')})`);
    if (Array.isArray(v) && (v.length > max || v.some((x) => typeof x === 'string' && x.length > itemMax))) throw new EngineError(`"${field}" has too many entries, or one that is too long (at most ${max} of ${itemMax} characters)`);
  }
}

/** Shared state and plumbing every engine module builds on. */
export class Core {
  readonly store: Storage;
  readonly agents: AgentLink;
  readonly publicUrl: string;
  readonly timings: Timings;
  readonly bus = new EventEmitter<BusEvents>();
  readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  gateway!: TerminalGateway;

  readonly hosts: Collection<Host>;
  readonly employees: Collection<Employee>;
  readonly sessions: Collection<AgentSession>;
  readonly projects: Collection<Project>;
  readonly tasks: Collection<Task>;
  readonly questions: Collection<Question>;
  readonly messages: Collection<Message>;
  readonly collabs: Collection<CollabRequest>;
  readonly notifications: Collection<Notification>;
  readonly meetings: Collection<Meeting>;
  readonly artifacts: Collection<Artifact>;
  readonly xp: Collection<XpEntry>;
  readonly lessons: Collection<Lesson>;
  readonly improvements: Collection<Improvement>;
  readonly routines: Collection<Routine>;

  private _settings: OwnerSettings;
  private _layout: OfficeLayout;
  private _milestones: Milestone[];
  private _company: CompanyStats;

  constructor(opts: EngineOptions) {
    this.store = opts.store;
    this.agents = opts.agents;
    this.publicUrl = opts.publicUrl.replace(/\/+$/, '');
    this.timings = { ...DEFAULT_TIMINGS, ...(opts.timings ?? {}) };
    this.log = opts.log ?? (() => undefined);
    const s = this.store;
    this.hosts = s.col('host');
    this.employees = s.col('employee');
    this.sessions = s.col('session');
    this.projects = s.col('project');
    this.tasks = s.col('task');
    this.questions = s.col('question');
    this.messages = s.col('message');
    this.collabs = s.col('collab');
    this.notifications = s.col('notification');
    this.meetings = s.col('meeting');
    this.artifacts = s.col('artifact');
    this.xp = s.col('xp');
    this.lessons = s.col('lesson');
    this.improvements = s.col('improvement');
    this.routines = s.col('routine');
    this._settings = { ...DEFAULT_SETTINGS, ...s.kvGet<Partial<OwnerSettings>>('settings', {}) };
    // Offices created before sidestepping existed: A/D turn, Q/E sidestep, and "interact" moves off E.
    const kb = this._settings.keybindings;
    if (!kb.strafeLeft) {
      this._settings.keybindings = { ...DEFAULT_SETTINGS.keybindings, ...kb, strafeLeft: 'KeyQ', strafeRight: 'KeyE', ...(kb.interact === 'KeyE' ? { interact: 'Space' } : {}) };
    }
    this._settings.keybindings = { ...DEFAULT_SETTINGS.keybindings, ...(this._settings.keybindings ?? {}) };
    this._settings.selfImprovement = { ...DEFAULT_SETTINGS.selfImprovement, ...(this._settings.selfImprovement ?? {}) };
    this._settings.selfImprovement = sanitizeAutopilot(this._settings.selfImprovement, DEFAULT_SETTINGS.selfImprovement);
    this._settings.foreman = sanitizeForeman(this._settings.foreman, DEFAULT_SETTINGS.foreman, this.foremanGapFloor);
    this._settings.sleepAfterMinutes = sanitizeSleep(this._settings.sleepAfterMinutes, DEFAULT_SETTINGS.sleepAfterMinutes);
    this._layout = s.kvGet<OfficeLayout | null>('layout', null) ?? defaultLayout();
    this._milestones = s.kvGet<Milestone[] | null>('milestones', null) ?? initialMilestones();
    this._company = { ...emptyCompanyStats(), ...s.kvGet<Partial<CompanyStats>>('company', {}) };
  }

  private col(kind: EntityKind): Collection<any> {
    switch (kind) {
      case 'host':
        return this.hosts;
      case 'employee':
        return this.employees;
      case 'session':
        return this.sessions;
      case 'project':
        return this.projects;
      case 'task':
        return this.tasks;
      case 'question':
        return this.questions;
      case 'message':
        return this.messages;
      case 'collab':
        return this.collabs;
      case 'notification':
        return this.notifications;
      case 'meeting':
        return this.meetings;
      case 'artifact':
        return this.artifacts;
      case 'lesson':
        return this.lessons;
      case 'improvement':
        return this.improvements;
      case 'routine':
        return this.routines;
      default:
        throw new Error(`no collection for ${kind}`);
    }
  }

  /**
   * Projects, tasks and employees that were deleted while this process runs. Work that was already under way when one was
   * deleted (a test run, a merge) still holds the record and writes it back when it finishes; that write is
   * dropped here, so what was deleted stays deleted. (Ids are never used twice.)
   */
  private deleted = new Set<string>();

  /** Persist an entity and broadcast the change to every connected office client. */
  put<T extends { id: string }>(kind: EntityKind, entity: T): T {
    if (this.deleted.has(`${kind}:${entity.id}`)) return entity;
    this.col(kind).put(entity);
    this.bus.emit('entity', kind, 'upsert', entity);
    return entity;
  }

  remove(kind: EntityKind, id: string): void {
    if (kind === 'project' || kind === 'task' || kind === 'employee') this.deleted.add(`${kind}:${id}`);
    if (this.col(kind).delete(id)) this.bus.emit('entity', kind, 'remove', { id });
  }

  /** Broadcast without persisting (high-frequency, derivable data such as host resources). */
  broadcast(kind: EntityKind, entity: unknown): void {
    this.bus.emit('entity', kind, 'upsert', entity);
  }

  /**
   * Record a normalized event. Returns null if an event with this id was
   * already recorded (idempotent redelivery).
   */
  event(e: {
    type: EventType;
    summary: string;
    source: EventSourceKind;
    id?: string;
    ts?: string;
    hostId?: string | null;
    sessionId?: string | null;
    employeeId?: string | null;
    taskId?: string | null;
    projectId?: string | null;
    correlationId?: string | null;
    data?: Record<string, unknown>;
  }): OrchestratorEvent | null {
    const stored = this.store.appendEvent({
      id: e.id ?? newId(),
      ts: e.ts ?? nowIso(),
      type: e.type,
      source: { kind: e.source, hostId: e.hostId ?? null },
      correlationId: e.correlationId ?? null,
      hostId: e.hostId ?? null,
      sessionId: e.sessionId ?? null,
      employeeId: e.employeeId ?? null,
      taskId: e.taskId ?? null,
      projectId: e.projectId ?? null,
      summary: e.summary,
      data: e.data ?? {},
    });
    if (stored) this.bus.emit('event', stored);
    return stored;
  }

  audit(actor: string, action: string, target: string, detail: Record<string, unknown> = {}): void {
    this.store.audit(actor, action, target, detail);
  }

  get settings(): OwnerSettings {
    return this._settings;
  }

  /** The shortest gap between foreman rounds the owner can ask for, in seconds. */
  private get foremanGapFloor(): number {
    return Math.max(1, Math.ceil(this.timings.foremanMinGapMs / 1000));
  }

  updateSettings(patch: Partial<OwnerSettings>): OwnerSettings {
    const autopilotBefore = this._settings.selfImprovement;
    this._settings = {
      ...this._settings,
      ...patch,
      keybindings: { ...this._settings.keybindings, ...(patch.keybindings ?? {}) },
      ...(patch.radio ? { radio: sanitizeRadio(patch.radio, this._settings.radio) } : {}),
      ...(patch.tv ? { tv: sanitizeTv(patch.tv, this._settings.tv) } : {}),
      selfImprovement: { ...this._settings.selfImprovement, ...(patch.selfImprovement ?? {}) },
      foreman: patch.foreman === undefined ? this._settings.foreman : sanitizeForeman(patch.foreman, this._settings.foreman, this.foremanGapFloor),
      sleepAfterMinutes: patch.sleepAfterMinutes === undefined ? this._settings.sleepAfterMinutes : sanitizeSleep(patch.sleepAfterMinutes, this._settings.sleepAfterMinutes),
      // A switch is on or off (anything that is not a plain "off" keeps the hold).
      ...(patch.unrestrictedAsksHighRisk === undefined ? {} : { unrestrictedAsksHighRisk: patch.unrestrictedAsksHighRisk !== false }),
      // A place the office knows, or the one it had.
      ...(patch.surroundings === undefined ? {} : { surroundings: (SURROUNDINGS as readonly unknown[]).includes(patch.surroundings) ? patch.surroundings : this._settings.surroundings }),
      // Who reviews a finished task when nobody chose: one of the four, or what it was.
      ...(patch.reviewDefault === undefined ? {} : { reviewDefault: (REVIEW_BY as readonly unknown[]).includes(patch.reviewDefault) ? patch.reviewDefault : this._settings.reviewDefault }),
    };
    this._settings.selfImprovement = sanitizeAutopilot(this._settings.selfImprovement, autopilotBefore);
    this.store.kvSet('settings', this._settings);
    this.bus.emit('entity', 'settings', 'upsert', this._settings);
    return this._settings;
  }

  get layout(): OfficeLayout {
    return this._layout;
  }

  setLayout(layout: OfficeLayout): void {
    this._layout = layout;
    this.store.kvSet('layout', layout);
    this.bus.emit('entity', 'layout', 'upsert', layout);
  }

  get milestones(): Milestone[] {
    return this._milestones;
  }

  saveMilestones(): void {
    this.store.kvSet('milestones', this._milestones);
    for (const m of this._milestones) this.bus.emit('entity', 'milestone', 'upsert', m);
  }

  get company(): CompanyStats {
    return this._company;
  }

  saveCompany(): void {
    deriveCompanyStats(this._company);
    this.store.kvSet('company', this._company);
    this.bus.emit('entity', 'company', 'upsert', this._company);
  }

  employeeByName(name: string): Employee | undefined {
    const n = name.trim().toLowerCase();
    if (!n) return undefined;
    const live = this.employees.filter((e) => !e.archived);
    return live.find((e) => e.name.toLowerCase() === n) ?? live.find((e) => e.name.toLowerCase().split(/\s+/)[0] === n) ?? live.find((e) => e.name.toLowerCase().startsWith(n));
  }

  /** The session currently representing an employee (prefers a running one). */
  sessionOf(employeeId: string | null | undefined): AgentSession | undefined {
    if (!employeeId) return undefined;
    const all = this.sessions.filter((s) => s.employeeId === employeeId);
    return all.find((s) => s.status === 'running' || s.status === 'starting') ?? all.sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))[0];
  }

  runningSessionOf(employeeId: string | null | undefined): AgentSession | undefined {
    const s = this.sessionOf(employeeId);
    return s && (s.status === 'running' || s.status === 'starting') ? s : undefined;
  }
}
