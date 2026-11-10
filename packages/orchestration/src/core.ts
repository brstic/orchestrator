import { EventEmitter } from 'node:events';
import type {
  AgentRpc,
  AgentSession,
  Artifact,
  CollabRequest,
  CompanyStats,
  Employee,
  EntityKind,
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
  Task,
  XpEntry,
  EventSourceKind,
} from '@orchestrator/contracts';
import { defaultLayout, newId, nowIso } from '@orchestrator/contracts';
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
  /** How long each meeting round waits for contributions. */
  meetingRoundMs: number;
  /** Delay between a session becoming idle and Orchestrator typing into it. */
  deliverySettleMs: number;
  /** A pasted prompt that no hook confirmed is considered unconfirmed after this long. */
  deliveryConfirmMs: number;
  /** Default verification command timeout. */
  verifyTimeoutMs: number;
  scheduleDebounceMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  askBossWaitMs: 240_000,
  meetingRoundMs: 8 * 60_000,
  deliverySettleMs: 350,
  deliveryConfirmMs: 20_000,
  verifyTimeoutMs: 240_000,
  scheduleDebounceMs: 120,
};

export interface EngineOptions {
  store: Storage;
  agents: AgentLink;
  /** Base URL workers use to reach the Orchestrator MCP endpoint. */
  publicUrl: string;
  timings?: Partial<Timings>;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface BusEvents {
  entity: [kind: EntityKind, op: 'upsert' | 'remove', data: any];
  event: [event: OrchestratorEvent];
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

const DEFAULT_SETTINGS: OwnerSettings = {
  companyName: 'My Company',
  ownerName: 'Boss',
  gamification: true,
  nlFallback: false,
  workersInheritMcp: false,
  autoAsksHighRisk: true,
  projectZones: false,
  approachZoom: false,
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
  selfImprovement: { enabled: true, retrospectives: 'friction', autoApproveSharedLessons: false, learnedRouting: true },
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
    this._settings = { ...DEFAULT_SETTINGS, ...s.kvGet<Partial<OwnerSettings>>('settings', {}) };
    // Offices created before sidestepping existed: A/D turn, Q/E sidestep, and "interact" moves off E.
    const kb = this._settings.keybindings;
    if (!kb.strafeLeft) {
      this._settings.keybindings = { ...DEFAULT_SETTINGS.keybindings, ...kb, strafeLeft: 'KeyQ', strafeRight: 'KeyE', ...(kb.interact === 'KeyE' ? { interact: 'Space' } : {}) };
    }
    this._settings.keybindings = { ...DEFAULT_SETTINGS.keybindings, ...(this._settings.keybindings ?? {}) };
    this._settings.selfImprovement = { ...DEFAULT_SETTINGS.selfImprovement, ...(this._settings.selfImprovement ?? {}) };
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
      default:
        throw new Error(`no collection for ${kind}`);
    }
  }

  /** Persist an entity and broadcast the change to every connected office client. */
  put<T extends { id: string }>(kind: EntityKind, entity: T): T {
    this.col(kind).put(entity);
    this.bus.emit('entity', kind, 'upsert', entity);
    return entity;
  }

  remove(kind: EntityKind, id: string): void {
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

  updateSettings(patch: Partial<OwnerSettings>): OwnerSettings {
    this._settings = {
      ...this._settings,
      ...patch,
      keybindings: { ...this._settings.keybindings, ...(patch.keybindings ?? {}) },
      ...(patch.radio ? { radio: sanitizeRadio(patch.radio, this._settings.radio) } : {}),
      ...(patch.tv ? { tv: sanitizeTv(patch.tv, this._settings.tv) } : {}),
      selfImprovement: { ...this._settings.selfImprovement, ...(patch.selfImprovement ?? {}) },
    };
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
