import { create } from 'zustand';
import type {
  AccountUsage,
  AgentSession,
  Artifact,
  CollabRequest,
  CompanyStats,
  ControlState,
  Employee,
  FullState,
  Host,
  Improvement,
  KnockView,
  Lesson,
  Meeting,
  Message,
  Milestone,
  Notification,
  OfficeLayout,
  OrchestratorEvent,
  OwnerSettings,
  PerformanceStat,
  Project,
  Question,
  ServerToClient,
  Me,
  PersonPresence,
  Task,
  TerminalScreen,
} from '@orchestrator/contracts';
import { b64decode } from '@orchestrator/contracts';
import { api, connection, type ConnState } from './api.ts';
import { playKnock, playOuch, playReply, playWhip } from './sfx.ts';

export type PanelId =
  | 'tasks'
  | 'projects'
  | 'notifications'
  | 'overview'
  | 'map'
  | 'team'
  | 'hosts'
  | 'wall'
  | 'meetings'
  | 'growth'
  | 'settings'
  | 'ceo'
  | 'employee'
  | 'question'
  | 'task'
  | 'office'
  | 'talk'
  | 'docs'
  | 'radio'
  | 'tv'
  | 'seat'
  | 'people'
  | 'myroom'
  | 'reports'
  | 'help';

export type CameraMode = 'ceo' | 'first' | 'management' | 'free' | 'workstation' | 'command';

export interface Nearby {
  kind: 'employee' | 'desk' | 'board' | 'meeting' | 'server' | 'ops' | 'ceo' | 'break' | 'reception' | 'hifi' | 'tv';
  id: string;
  label: string;
}

export interface DocFile {
  path: string;
  size: number;
  modifiedAt: string;
}

/** The Markdown files found in an employee's folder (read from their machine on request). */
export interface DocListing {
  root: string | null;
  files: DocFile[];
  truncated: boolean;
  unavailable?: string;
}

/** A question the app asks before doing something that cannot simply be undone. */
export interface Ask {
  title: string;
  /** What will happen, in a sentence or two. Lines are kept. */
  body?: string;
  /** The word on the button that goes ahead (default "OK"). */
  ok?: string;
  /** The button that goes ahead is red: something is deleted, stopped or taken away. */
  danger?: boolean;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

type ById<T> = Record<string, T>;

export interface OfficeState {
  /** Per employee: the documents last seen in their folder. */
  docs: ById<DocListing>;
  /** The hi-fi: what is playing in this window right now. */
  radio: { stationId: string | null; name: string | null; status: 'idle' | 'loading' | 'playing' | 'error'; error: string | null; nowPlaying: string | null };
  /** The office TV (a browser in this window): whether it is on, where it was asked to go, and what its page reports. */
  tv: { on: boolean; goto: { url: string; n: number } | null; page: { url: string; title: string; audible: boolean; loading: boolean; canGoBack: boolean; canGoForward: boolean } | null };
  tvOpen: (url?: string) => void;
  /** Who the person at this computer is in this office: its owner, or a guest with a role. */
  me: Me | null;
  /** Everyone present right now, this window included (matched by `clientId`). */
  people: PersonPresence[];
  /** Claude accounts the employees run on and how much of each is used (owner only; empty for guests). */
  accounts: AccountUsage[];
  /** This computer's own host in an office someone else runs (from the desktop app); `none` in one's own office or a browser. */
  myHost: { state: 'none' | 'starting' | 'online' | 'unavailable' | 'stopped'; reason: string | null; hostId: string | null };
  /** What people said to each other, most recent last. */
  /** `at` is when the line arrived at this computer (0: it was said before this window came in). */
  /** What people said (and did: `emote` lines read "<name> cracks the whip at …"), oldest first. */
  chat: Array<{ id: string; fromId: string; name: string; role: Me['role']; text: string; ts: string; emote?: boolean; hue?: number; at: number }>;
  /**
   * My own conversations with employees (this computer's, kept across a reload): whom I have told or asked
   * something and not heard back from yet, and whose answer is waiting for me to read. Only what I said
   * myself — not what employees say to each other, nor what other people ask.
   */
  asks: Record<string, { messageId: string | null; at: number }>;
  replies: Record<string, { text: string; ts: string }>;
  /** I said something to this employee (the message as the office recorded it). */
  asked: (employeeId: string, messageId: string | null) => void;
  /** I have seen what they answered (or no longer wait for it). */
  readReply: (employeeId: string) => void;
  /** Who is at the office's door asking to be let in (told to owners and colleagues). */
  knocks: KnockView[];
  /** When each other person in the office last cracked the whip (by their window id): their character swings. */
  peopleWhips: Record<string, number>;
  say: (text: string) => void;
  /** The employee the owner is carrying to another desk (walk to a desk and press the interact key), or null. */
  movingEmployeeId: string | null;
  setMoving: (employeeId: string | null) => void;
  tvOff: () => void;
  /** The owner's whip (a visual gag): who was last whipped and when, and when the owner last swung. */
  whips: Record<string, number>;
  whipAt: number;
  whip: (employeeId: string) => void;
  conn: ConnState;
  ready: boolean;
  clientId: string;
  settings: OwnerSettings | null;
  layout: OfficeLayout | null;
  hosts: ById<Host>;
  employees: ById<Employee>;
  sessions: ById<AgentSession>;
  projects: ById<Project>;
  tasks: ById<Task>;
  questions: ById<Question>;
  messages: ById<Message>;
  collabs: ById<CollabRequest>;
  notifications: ById<Notification>;
  meetings: ById<Meeting>;
  artifacts: ById<Artifact>;
  lessons: ById<Lesson>;
  improvements: ById<Improvement>;
  milestones: Milestone[];
  company: CompanyStats | null;
  performance: PerformanceStat[];
  events: OrchestratorEvent[];
  control: ById<{ control: ControlState; you: boolean }>;

  // ── UI state (never the source of truth for execution) ──
  panel: PanelId | null;
  panelArg: string | null;
  cameraMode: CameraMode;
  /** Camera mode to return to when leaving a workstation. */
  previousCameraMode: CameraMode;
  selectedEmployeeId: string | null;
  /** The employee whose workstation the owner is sitting at. */
  workstationId: string | null;
  nearby: Nearby | null;
  commandOpen: boolean;
  toasts: Toast[];
  /** The question on screen, if any (one at a time). */
  asking: (Ask & { resolve: (yes: boolean) => void }) | null;
  /** Ask the person, in the app's own dialog; resolves to their answer. */
  ask: (q: Ask) => Promise<boolean>;
  answer: (yes: boolean) => void;
  filter: { projectId: string | null; hostId: string | null; employeeId: string | null };
  /** Bumped to ask the 3D scene to move the player/camera to an employee. */
  focusRequest: { employeeId: string; n: number } | null;

  openPanel: (panel: PanelId | null, arg?: string | null) => void;
  setCameraMode: (mode: CameraMode) => void;
  selectEmployee: (id: string | null) => void;
  enterWorkstation: (employeeId: string) => void;
  leaveWorkstation: () => void;
  setNearby: (n: Nearby | null) => void;
  setCommandOpen: (open: boolean) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  setFilter: (f: Partial<OfficeState['filter']>) => void;
  focusEmployee: (employeeId: string) => void;
}

const KIND_TO_KEY: Record<string, keyof OfficeState> = {
  host: 'hosts',
  employee: 'employees',
  session: 'sessions',
  project: 'projects',
  task: 'tasks',
  question: 'questions',
  message: 'messages',
  collab: 'collabs',
  notification: 'notifications',
  meeting: 'meetings',
  artifact: 'artifacts',
  lesson: 'lessons',
  improvement: 'improvements',
};

function index<T extends { id: string }>(list: T[]): ById<T> {
  const out: ById<T> = {};
  for (const x of list) out[x.id] = x;
  return out;
}

let toastId = 0;
let focusN = 0;

const WAITING_KEY = 'orch.talk-waiting';
/** What I am waiting to hear, and what I have not read yet, as this computer remembers it. */
function loadWaiting(): Pick<OfficeState, 'asks' | 'replies'> {
  try {
    const j = JSON.parse(localStorage.getItem(WAITING_KEY) ?? '{}');
    // Nobody waits for an answer for days: what is older is forgotten.
    const fresh = Date.now() - 24 * 3600_000;
    const asks = Object.fromEntries(Object.entries((j.asks ?? {}) as OfficeState['asks']).filter(([, a]) => a && a.at > fresh));
    const replies = Object.fromEntries(Object.entries((j.replies ?? {}) as OfficeState['replies']).filter(([, r]) => r && Date.parse(r.ts) > fresh));
    return { asks, replies };
  } catch {
    return { asks: {}, replies: {} };
  }
}
function saveWaiting(): void {
  try {
    const s = useOffice.getState();
    localStorage.setItem(WAITING_KEY, JSON.stringify({ asks: s.asks, replies: s.replies }));
  } catch {
    /* no storage: remembered until the window is reloaded */
  }
}

/**
 * An employee I spoke to has finished a turn: that is their answer. It counts only once my message has
 * actually reached their session (a turn that ends while my message is still queued is the previous one's).
 */
function noteReply(ev: OrchestratorEvent): void {
  if (ev.type !== 'agent.turn_finished' || !ev.employeeId) return;
  const s = useOffice.getState();
  const ask = s.asks[ev.employeeId];
  if (!ask) return;
  const delivery = ask.messageId ? s.messages[ask.messageId]?.delivery.status : 'sent';
  if (delivery === 'queued' || delivery === 'failed') return;
  const text = String((ev.data as { lastMessage?: unknown })?.lastMessage ?? '').trim();
  const asks = { ...s.asks };
  delete asks[ev.employeeId];
  // Looking at the conversation already: nothing to announce.
  const watching = (s.panel === 'talk' && s.panelArg === ev.employeeId) || (s.cameraMode === 'workstation' && s.workstationId === ev.employeeId);
  useOffice.setState(watching ? { asks } : { asks, replies: { ...s.replies, [ev.employeeId]: { text, ts: ev.ts } } });
  saveWaiting();
  if (!watching) playReply();
}

export const useOffice = create<OfficeState>((set, get) => ({
  conn: 'connecting',
  ready: false,
  clientId: '',
  settings: null,
  layout: null,
  hosts: {},
  employees: {},
  sessions: {},
  projects: {},
  tasks: {},
  questions: {},
  messages: {},
  collabs: {},
  notifications: {},
  meetings: {},
  artifacts: {},
  lessons: {},
  improvements: {},
  milestones: [],
  company: null,
  performance: [],
  events: [],
  control: {},
  docs: {},
  radio: { stationId: null, name: null, status: 'idle', error: null, nowPlaying: null },
  tv: { on: false, goto: null, page: null },
  me: null,
  people: [],
  accounts: [],
  myHost: { state: 'none', reason: null, hostId: null },
  chat: [],
  peopleWhips: {},
  knocks: [],
  ...loadWaiting(),
  asked: (employeeId, messageId) => {
    set((s) => {
      const replies = { ...s.replies };
      delete replies[employeeId];
      return { asks: { ...s.asks, [employeeId]: { messageId, at: Date.now() } }, replies };
    });
    saveWaiting();
  },
  readReply: (employeeId) => {
    const s = get();
    if (!s.replies[employeeId]) return;
    const replies = { ...s.replies };
    delete replies[employeeId];
    set({ replies });
    saveWaiting();
  },
  say: (text) => {
    const t = text.trim();
    if (t) connection.send({ t: 'say', text: t.slice(0, 300) });
  },
  movingEmployeeId: null,
  setMoving: (employeeId) => set({ movingEmployeeId: employeeId }),
  tvOpen: (url) => set((s) => ({ tv: { ...s.tv, on: true, goto: url ? { url, n: (s.tv.goto?.n ?? 0) + 1 } : s.tv.goto }, panel: 'tv', panelArg: null })),
  tvOff: () => set((s) => ({ tv: { on: false, goto: null, page: null }, panel: s.panel === 'tv' ? null : s.panel })),
  whips: {},
  whipAt: 0,
  whip: (employeeId) => {
    const now = Date.now();
    // Not too fast: one crack has to land before the next.
    if (now - get().whipAt < 650) return;
    set((s) => ({ whipAt: now, whips: { ...s.whips, [employeeId]: now + 230 } }));
    // Everyone in the office sees it (and it goes in the chat as what it is).
    connection.send({ t: 'whip', employeeId });
    playWhip();
    // Everyone yelps in their own voice.
    let h = 0;
    for (const ch of employeeId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    playOuch((h % 1000) / 1000);
  },

  panel: null,
  panelArg: null,
  cameraMode: 'ceo',
  previousCameraMode: 'ceo',
  selectedEmployeeId: null,
  workstationId: null,
  nearby: null,
  commandOpen: false,
  toasts: [],
  asking: null,
  ask: (q) =>
    new Promise<boolean>((resolve) => {
      // For the UI tests: a function here answers instead of a person (it is told what was asked).
      const auto = (window as unknown as { __orchConfirm?: (text: string) => boolean }).__orchConfirm;
      if (typeof auto === 'function') return resolve(!!auto(`${q.title}${q.body ? `\n\n${q.body}` : ''}`));
      // A second question while one is open: the first is taken as "no".
      get().asking?.resolve(false);
      set({ asking: { ...q, resolve } });
    }),
  answer: (yes) => {
    const a = get().asking;
    if (!a) return;
    set({ asking: null });
    a.resolve(yes);
  },
  filter: { projectId: null, hostId: null, employeeId: null },
  focusRequest: null,

  openPanel: (panel, arg = null) => {
    set({ panel, panelArg: arg });
    // Opening the conversation is reading the answer.
    if (panel === 'talk' && arg) get().readReply(arg);
  },
  setCameraMode: (mode) => set((s) => (s.cameraMode === mode ? s : { cameraMode: mode, workstationId: mode === 'workstation' ? s.workstationId : null })),
  selectEmployee: (id) => set({ selectedEmployeeId: id }),
  enterWorkstation: (employeeId) =>
    set((s) => ({ workstationId: employeeId, selectedEmployeeId: employeeId, previousCameraMode: s.cameraMode === 'workstation' ? s.previousCameraMode : s.cameraMode, cameraMode: 'workstation', panel: null })),
  leaveWorkstation: () => set((s) => ({ workstationId: null, cameraMode: s.previousCameraMode === 'workstation' ? 'ceo' : s.previousCameraMode })),
  setNearby: (n) => {
    const cur = get().nearby;
    if (cur?.id === n?.id && cur?.kind === n?.kind) return;
    set({ nearby: n });
  },
  setCommandOpen: (open) => set({ commandOpen: open }),
  toast: (text, kind = 'info') => {
    const id = ++toastId;
    // Three at most: more than that is a wall nobody reads, and the newest say what just happened.
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, kind, text }] }));
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setFilter: (f) => set((s) => ({ filter: { ...s.filter, ...f } })),
  focusEmployee: (employeeId) => set({ focusRequest: { employeeId, n: ++focusN }, selectedEmployeeId: employeeId }),
}));

// Handy for debugging from the console, and used by the screenshot tooling.
(window as any).__office = useOffice;

// ───────────────────── non-React stores for high-frequency data ─────────────────────

/** Latest monitor frame per session. Kept out of React state: it changes many times a second. */
export const screens = new Map<string, TerminalScreen>();
const screenListeners = new Map<string, Set<(s: TerminalScreen) => void>>();

export function onScreen(sessionId: string, fn: (s: TerminalScreen) => void): () => void {
  let set = screenListeners.get(sessionId);
  if (!set) screenListeners.set(sessionId, (set = new Set()));
  set.add(fn);
  const cur = screens.get(sessionId);
  if (cur) fn(cur);
  return () => set!.delete(fn);
}

export type TermEvent = { t: 'snapshot'; cols: number; rows: number; data: Uint8Array; seq: number } | { t: 'output'; data: Uint8Array; seq: number } | { t: 'closed'; reason: string };
const termListeners = new Map<string, Set<(e: TermEvent) => void>>();

export function onTerminal(sessionId: string, fn: (e: TermEvent) => void): () => void {
  let set = termListeners.get(sessionId);
  if (!set) termListeners.set(sessionId, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

function emitTerm(sessionId: string, e: TermEvent): void {
  for (const fn of termListeners.get(sessionId) ?? []) fn(e);
}

function applyFull(state: FullState, clientId: string): void {
  useOffice.setState({
    ready: true,
    clientId,
    settings: state.settings,
    layout: state.layout,
    hosts: index(state.hosts),
    employees: index(state.employees),
    sessions: index(state.sessions),
    projects: index(state.projects),
    tasks: index(state.tasks),
    questions: index(state.questions),
    messages: index(state.messages),
    collabs: index(state.collabs),
    notifications: index(state.notifications),
    meetings: index(state.meetings),
    artifacts: index(state.artifacts),
    lessons: index(state.lessons ?? []),
    improvements: index(state.improvements ?? []),
    milestones: state.milestones,
    company: state.company,
    performance: state.performance ?? [],
    events: state.events,
    control: {},
  });
}

function handle(msg: ServerToClient): void {
  switch (msg.t) {
    case 'ready':
      applyFull(msg.state, msg.clientId);
      // Answers that came while this window was away (a reload, a lost connection).
      for (const ev of msg.state.events ?? []) if (ev.employeeId && Date.parse(ev.ts) > (useOffice.getState().asks[ev.employeeId]?.at ?? Infinity)) noteReply(ev);
      useOffice.setState({ me: msg.me ?? { kind: 'owner', role: 'owner', name: msg.state.settings.ownerName }, clientId: msg.clientId, people: [], knocks: [] });
      break;
    case 'people': {
      // Only the others are drawn from this list; if just my own entry moved, nothing on screen changes.
      const st = useOffice.getState();
      const others = (list: typeof msg.people) => JSON.stringify(list.filter((p) => p.id !== st.clientId));
      if (st.people.length === msg.people.length && others(st.people) === others(msg.people)) break;
      useOffice.setState({ people: msg.people });
      break;
    }
    case 'knocks': {
      // A knock on the door is heard, once per new person.
      const had = new Set(useOffice.getState().knocks.map((k) => k.id));
      if (msg.knocks.some((k) => !had.has(k.id))) playKnock();
      useOffice.setState({ knocks: msg.knocks });
      break;
    }
    case 'chat.history':
      // What was said before this window walked in (only if nothing has been heard here yet).
      if (!useOffice.getState().chat.length) useOffice.setState({ chat: msg.lines.map((l, i) => ({ id: `h-${l.ts}-${i}`, fromId: l.from.id, name: l.from.name, role: l.from.role, hue: l.from.hue, text: l.text, ts: l.ts, emote: l.emote, at: 0 })) });
      break;
    case 'whipped': {
      const st = useOffice.getState();
      const victim = st.employees[msg.employeeId];
      const line = { id: `w-${msg.ts}-${msg.from.id}`, fromId: msg.from.id, name: msg.from.name, role: msg.from.role, hue: msg.from.hue, text: `cracks the whip at ${victim?.name ?? 'someone'}`, ts: msg.ts, emote: true, at: Date.now() };
      if (msg.from.id === st.clientId) {
        // My own crack: already swung and heard here; only the line for the chat.
        useOffice.setState((s) => ({ chat: [...s.chat.slice(-49), line] }));
        break;
      }
      const now = Date.now();
      useOffice.setState((s) => ({ chat: [...s.chat.slice(-49), line], peopleWhips: { ...s.peopleWhips, [msg.from.id]: now }, whips: { ...s.whips, [msg.employeeId]: now + 230 } }));
      playWhip();
      let h = 0;
      for (const ch of msg.employeeId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      playOuch((h % 1000) / 1000);
      break;
    }
    case 'said':
      useOffice.setState((s) => ({ chat: [...s.chat.slice(-49), { id: `${msg.ts}-${msg.from.id}-${s.chat.length}`, fromId: msg.from.id, name: msg.from.name, role: msg.from.role, hue: msg.from.hue, text: msg.text, ts: msg.ts, at: Date.now() }] }));
      break;
    case 'entity': {
      const key = KIND_TO_KEY[msg.kind];
      if (key) {
        useOffice.setState((s) => {
          const map = { ...(s[key] as ById<any>) };
          if (msg.op === 'remove') delete map[msg.data.id];
          else map[msg.data.id] = msg.data;
          // The session record is the authority on who controls a terminal. The per-viewer control
          // messages only arrive while this client has that terminal open, so a remembered one must
          // not outlive a change it never heard about (e.g. a pause made from a panel).
          const seen = msg.kind === 'session' && msg.op !== 'remove' ? s.control[msg.data.id] : undefined;
          if (seen && seen.control !== msg.data.control) {
            return { [key]: map, control: { ...s.control, [msg.data.id]: { control: msg.data.control, you: msg.data.control === 'HUMAN_CONTROLLED' && msg.data.controllerId === s.clientId } } } as Partial<OfficeState>;
          }
          return { [key]: map } as Partial<OfficeState>;
        });
      } else if (msg.kind === 'settings') useOffice.setState({ settings: msg.data });
      else if (msg.kind === 'layout') useOffice.setState({ layout: msg.data });
      else if (msg.kind === 'company') useOffice.setState({ company: msg.data });
      else if (msg.kind === 'performance') useOffice.setState({ performance: msg.data });
      else if (msg.kind === 'milestone') useOffice.setState((s) => ({ milestones: s.milestones.some((m) => m.key === msg.data.key) ? s.milestones.map((m) => (m.key === msg.data.key ? msg.data : m)) : [...s.milestones, msg.data] }));
      break;
    }
    case 'event':
      useOffice.setState((s) => ({ events: s.events.length > 700 ? [...s.events.slice(-500), msg.event] : [...s.events, msg.event] }));
      noteReply(msg.event);
      break;
    case 'term.screen': {
      screens.set(msg.sessionId, msg.screen);
      for (const fn of screenListeners.get(msg.sessionId) ?? []) fn(msg.screen);
      break;
    }
    case 'term.snapshot':
      emitTerm(msg.snapshot.sessionId, { t: 'snapshot', cols: msg.snapshot.cols, rows: msg.snapshot.rows, data: b64decode(msg.snapshot.data), seq: msg.snapshot.seq });
      break;
    case 'term.output':
      emitTerm(msg.sessionId, { t: 'output', data: b64decode(msg.data), seq: msg.seq });
      break;
    case 'term.closed':
      emitTerm(msg.sessionId, { t: 'closed', reason: msg.reason });
      break;
    case 'control':
      useOffice.setState((s) => ({ control: { ...s.control, [msg.sessionId]: { control: msg.control, you: msg.you } } }));
      break;
    case 'error':
      useOffice.getState().toast(msg.message, 'error');
      break;
  }
}

let started = false;
export function startConnection(): void {
  if (started) return;
  started = true;
  connection.on(handle);
  connection.onState((conn) => useOffice.setState({ conn }));
  connection.connect();
}

// ─────────────────────────── selectors ───────────────────────────

/** Read the list of Markdown files in an employee's folder from their machine and remember it. */
export async function loadDocs(employeeId: string): Promise<DocListing> {
  const listing = await api<DocListing>('GET', `/employees/${employeeId}/docs`).catch((e) => ({ root: null, files: [], truncated: false, unavailable: (e as Error).message }) as DocListing);
  useOffice.setState((s) => ({ docs: { ...s.docs, [employeeId]: listing } }));
  return listing;
}

export function sessionOfEmployee(sessions: ById<AgentSession>, employeeId: string | null | undefined): AgentSession | undefined {
  if (!employeeId) return undefined;
  let best: AgentSession | undefined;
  for (const s of Object.values(sessions)) {
    if (s.employeeId !== employeeId) continue;
    const live = s.status === 'running' || s.status === 'starting';
    if (live) return s;
    if (!best || s.startedAt > best.startedAt) best = s;
  }
  return best;
}

export function currentTaskOf(tasks: ById<Task>, employeeId: string | null | undefined): Task | undefined {
  if (!employeeId) return undefined;
  let best: Task | undefined;
  for (const t of Object.values(tasks)) {
    if (t.assigneeId === employeeId && t.status === 'IN_PROGRESS' && (!best || (t.startedAt ?? '') > (best.startedAt ?? ''))) best = t;
  }
  return best;
}

export function openQuestionsOf(questions: ById<Question>, employeeId: string): Question[] {
  return Object.values(questions).filter((q) => q.employeeId === employeeId && q.status === 'open');
}

/** What the employee is really doing, for display. Offline when there is no live session. */
export function activityOf(session: AgentSession | undefined): string {
  if (!session) return 'offline';
  if (session.status === 'host_offline') return 'unknown';
  if (session.status !== 'running' && session.status !== 'starting') return 'offline';
  return session.activity;
}

/** Ask the office how much of each Claude account is used (owner only). */
export async function loadAccounts(): Promise<void> {
  try {
    useOffice.setState({ accounts: await api<AccountUsage[]>('GET', '/usage') });
  } catch {
    /* a guest, or the office is not reachable right now: keep what is shown */
  }
}

// The desktop app says how this computer's own host in the office is doing.
{
  const bridge = (window as unknown as { orchestrator?: { myHost?: { get: () => Promise<OfficeState['myHost']>; onState: (cb: (s: OfficeState['myHost']) => void) => () => void } } }).orchestrator?.myHost;
  if (bridge) {
    void bridge.get().then((myHost) => myHost && useOffice.setState({ myHost }), () => undefined);
    bridge.onState((myHost) => useOffice.setState({ myHost }));
  }
}
