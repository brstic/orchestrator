import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { AgentSession, ControlState, Employee, Host, Notification, OfficeLayout, OrchestratorEvent, Question, RoomDef, SessionCapabilities, Task } from '@orchestrator/contracts';
import { ACTIVITY_LABEL, LEVEL_THRESHOLDS, unlockedUpgrades } from '@orchestrator/contracts';
import { Badge, Button, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import './panels-company.css';

/** Helpers shared by the company-side panels. Nothing here invents data: it only formats what the store holds. */

export interface PanelProps {
  arg: string | null;
  onClose: () => void;
}

export const NOT_AVAILABLE = 'not available';

const CAPABILITIES: Array<{ key: keyof SessionCapabilities; label: string; tip: string }> = [
  { key: 'terminal', label: 'terminal', tip: 'Live terminal stream and input through tmux' },
  { key: 'hooks', label: 'hooks', tip: 'Claude Code lifecycle hooks reach Orchestrator, so activity is observed rather than guessed' },
  { key: 'mcp', label: 'mcp', tip: 'The Orchestrator MCP server is configured for this session (tasks, questions, reports)' },
  { key: 'structuredApproval', label: 'structured approval', tip: 'Permission requests can be answered from the office' },
  { key: 'structuredMessaging', label: 'structured messaging', tip: 'Messages can be delivered without typing into the terminal' },
  { key: 'usage', label: 'usage', tip: 'Token usage can be measured from the session transcript' },
];

/** What this particular session genuinely supports — present and missing capabilities are both shown. */
export function CapabilityBadges({ capabilities }: { capabilities: SessionCapabilities }) {
  return (
    <span className="row row-wrap" style={{ gap: 4 }}>
      {CAPABILITIES.map((c) => (
        <Badge key={c.key} tone={capabilities[c.key] ? 'good' : 'muted'} title={`${capabilities[c.key] ? 'Available' : 'Not available'}: ${c.tip}`}>
          {capabilities[c.key] ? c.label : `no ${c.label}`}
        </Badge>
      ))}
    </span>
  );
}

export const CONTROL_STATES: Array<{ id: ControlState; label: string; text: string }> = [
  { id: 'AGENT_CONTROLLED', label: 'Working on its own', text: 'Nobody is watching the terminal; the Claude Code session works on its own.' },
  { id: 'HUMAN_OBSERVING', label: 'Human observing', text: 'You are watching the live terminal read-only. Keystrokes are dropped by the server; the employee keeps working.' },
  { id: 'HUMAN_CONTROLLED', label: 'Human controlled', text: 'You hold the keyboard: what you type goes into that exact tmux session. Orchestrator holds back its own deliveries until you return control.' },
  { id: 'PAUSED', label: 'Paused', text: 'You interrupted the employee (Escape, or the SDK interrupt for an SDK-managed worker) and have not resumed it. Nothing new is delivered until you do.' },
  { id: 'DISCONNECTED', label: 'Disconnected', text: 'The machine or the session terminal is unreachable. Nothing can be observed or sent.' },
];

export function runtimeLabel(session: AgentSession): string {
  if (session.origin !== 'managed') return 'Attached — an existing tmux session Orchestrator did not start';
  return session.mode === 'managed_sdk' ? 'SDK-managed — started by Orchestrator and driven through the Claude Agent SDK' : 'Interactive Claude Code — started by Orchestrator in tmux';
}

const NOT_WORKING = new Set(['offline', 'unknown', 'idle', 'waiting_input', 'paused']);

/** Same definition the top bar uses for "working". */
export function isWorking(activity: string): boolean {
  return !NOT_WORKING.has(activity);
}

export function isLive(session: AgentSession | undefined): boolean {
  return !!session && (session.status === 'running' || session.status === 'starting');
}

export function activityTone(activity: string, needsYou = false): Tone {
  if (needsYou || activity === 'waiting_answer' || activity === 'needs_approval') return 'warn';
  if (activity === 'blocked') return 'bad';
  if (activity === 'offline' || activity === 'unknown') return 'muted';
  if (activity === 'task_complete') return 'good';
  if (activity === 'idle' || activity === 'waiting_input' || activity === 'paused') return 'neutral';
  return 'info';
}

const ACTIVITY_TIP: Record<string, string> = {
  offline: 'Asleep — no session is running; talking to them or giving them a task wakes them',
  unknown: 'Cannot be observed right now (no hooks in this session, or its machine is offline). Nothing is inferred.',
};

/** The employee's real state. `unknown` and `offline` are shown as exactly that. */
export function ActivityBadge({ activity, needsYou }: { activity: string; needsYou?: boolean }) {
  return (
    <Badge tone={activityTone(activity, needsYou)} title={ACTIVITY_TIP[activity] ?? 'From real session signals (hooks, MCP reports, process state)'}>
      {ACTIVITY_LABEL[activity] ?? activity.toUpperCase()}
    </Badge>
  );
}

/** Whether an employee is waiting on the owner or stuck, from questions, tasks and session activity. */
export function attentionOf(employeeId: string, activity: string, questions: Record<string, Question>, tasks: Record<string, Task>): 'needs' | 'blocked' | null {
  if (activity === 'waiting_answer' || activity === 'needs_approval') return 'needs';
  for (const q of Object.values(questions)) if (q.employeeId === employeeId && q.status === 'open') return 'needs';
  if (activity === 'blocked') return 'blocked';
  for (const t of Object.values(tasks)) if (t.assigneeId === employeeId && t.status === 'BLOCKED' && !t.waitingFor) return 'blocked';
  return null;
}

export function hostDotClass(host: Host | undefined): string {
  if (!host) return 'dot';
  return host.status === 'online' ? 'dot dot-good' : host.status === 'offline' ? 'dot dot-bad' : 'dot';
}

export function HostLabel({ host }: { host: Host | undefined }) {
  if (!host) return <span className="faint">no machine</span>;
  return (
    <span className="row" style={{ gap: 6 }} title={`${host.name} is ${host.status}`}>
      <span className={hostDotClass(host)} />
      <span className="truncate">{host.name}</span>
    </span>
  );
}

/** Progress inside the current level, from the shared threshold table. */
export function levelInfo(xp: number, level: number): { floor: number; next: number | null; pct: number } {
  const floor = LEVEL_THRESHOLDS[level - 1] ?? 0;
  const next = LEVEL_THRESHOLDS[level] ?? null;
  const pct = next == null || next <= floor ? 100 : Math.max(0, Math.min(100, ((xp - floor) / (next - floor)) * 100));
  return { floor, next, pct };
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

export function fmtBytes(n: number): string {
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '?';
}

export function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

export function humanize(key: string): string {
  return key.replace(/_/g, ' ');
}

/** `KeyW` → `W`, `ArrowUp` → `↑`: how a KeyboardEvent.code is shown to the owner. */
export function keyLabel(code: string | undefined): string {
  if (!code) return '—';
  const arrows: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  if (arrows[code]) return arrows[code]!;
  if (code === 'Escape') return 'Esc';
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
}

/** Re-render on a slow clock, for "time in state" style labels. */
export function useTick(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setN((x) => x + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return n;
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** GET a resource that is not part of the live store (audit log, XP ledger, event history). */
export function useLoad<T>(path: string | null): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api<T>('GET', path).then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e: Error) => alive && setState({ data: null, error: e.message, loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [path, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

export function LoadState({ load, what }: { load: Loaded<unknown>; what: string }) {
  if (load.error)
    return (
      <div className="row">
        <Badge tone="bad">Could not load {what}</Badge>
        <span className="small muted">{load.error}</span>
        <Button small onClick={load.reload}>
          Retry
        </Button>
      </div>
    );
  if (load.loading && !load.data) return <div className="small muted">Loading {what}…</div>;
  return null;
}

/** An inline confirmation for destructive actions: says what will happen before it does. */
export function ConfirmBox({ title, children, confirmLabel, busy, onConfirm, onCancel }: { title: ReactNode; children?: ReactNode; confirmLabel: string; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="pc-confirm" role="alertdialog" aria-label={typeof title === 'string' ? title : undefined}>
      <div className="strong">{title}</div>
      {children && <div className="small">{children}</div>}
      <div className="row">
        <Button variant="danger" small disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button variant="ghost" small disabled={busy} onClick={onCancel} autoFocus>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Enter / Space activate a non-button element that acts as one. */
export function onActivate(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
}

export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    useOffice.getState().toast(what, 'success');
  } catch {
    useOffice.getState().toast('Could not copy — select the text and copy it manually', 'error');
  }
}

export function eventTone(e: OrchestratorEvent): string {
  if (/completed|merged|answered|milestone|level_up|lesson|applied/.test(e.type)) return 'feed-good';
  if (/blocked|failed|conflict|lost|disconnected|revoked/.test(e.type)) return 'feed-bad';
  if (/question|permission_requested|review_requested|proposed/.test(e.type)) return 'feed-warn';
  return '';
}

/** The events the office feed shows: recorded, and not marked quiet. */
export function isLoudEvent(e: OrchestratorEvent): boolean {
  return !(e.data as { quiet?: unknown } | null)?.quiet && e.type !== 'session.activity';
}

export function severityDot(severity: Notification['severity']): string {
  return severity === 'critical' ? 'dot dot-bad' : severity === 'warning' ? 'dot dot-warn' : severity === 'success' ? 'dot dot-good' : 'dot dot-info';
}

/** Go to what a notification is about. Returns true when the panel that showed it should close. */
export function openNotificationTarget(n: Notification): boolean {
  const st = useOffice.getState();
  if (n.questionId && st.questions[n.questionId]) st.openPanel('question', n.questionId);
  else if (n.taskId && st.tasks[n.taskId]) st.openPanel('task', n.taskId);
  else if (n.employeeId && st.employees[n.employeeId]) {
    st.focusEmployee(n.employeeId);
    return true;
  } else if (n.hostId && st.hosts[n.hostId]) st.openPanel('hosts');
  return false;
}

/** Office upgrades granted by unlocked milestones (rooms with `requires` appear only then). */
export function useUnlocked(): Set<string> {
  const milestones = useOffice((s) => s.milestones);
  return useMemo(() => new Set(unlockedUpgrades(milestones)), [milestones]);
}

export function visibleRooms(layout: OfficeLayout, unlocked: Set<string>): RoomDef[] {
  return layout.rooms.filter((r) => !r.requires || unlocked.has(r.requires));
}

/**
 * The office floor as an SVG. Units are metres; x runs −width/2…+width/2 and z
 * (drawn downwards) −depth/2…+depth/2, exactly as in the 3D scene.
 */
export function OfficeSvg({ layout, unlocked, children, label, style }: { layout: OfficeLayout; unlocked: Set<string>; children?: ReactNode; label: string; style?: CSSProperties }) {
  const rooms = visibleRooms(layout, unlocked);
  return (
    <svg className="minimap pc-map" style={style} viewBox={`${-layout.width / 2} ${-layout.depth / 2} ${layout.width} ${layout.depth}`} role="group" aria-label={label}>
      <rect x={-layout.width / 2 + 0.06} y={-layout.depth / 2 + 0.06} width={layout.width - 0.12} height={layout.depth - 0.12} fill="#0e131c" stroke="rgba(255,255,255,0.25)" strokeWidth={0.12} />
      {rooms
        .filter((r) => r.kind !== 'hall')
        .map((r) => (
          <g key={r.id}>
            <rect className={`pc-map-room ${r.open ? 'pc-map-room-open' : ''}`} x={r.x} y={r.z} width={r.w} height={r.d} />
            {/* Open-plan areas hold the desks, so their name goes in the far corner, clear of the name labels. */}
            {r.open ? (
              <text className="pc-map-room-label" x={r.x + r.w - 0.45} y={r.z + r.d - 0.45} textAnchor="end">
                {r.name}
              </text>
            ) : (
              <text className="pc-map-room-label" x={r.x + 0.45} y={r.z + 0.95}>
                {r.name}
              </text>
            )}
          </g>
        ))}
      {children}
    </svg>
  );
}

/** Non-archived employees keyed by the desk they sit at. */
export function occupantsByDesk(employees: Record<string, Employee>): Map<string, Employee> {
  const out = new Map<string, Employee>();
  for (const e of Object.values(employees)) if (!e.archived && e.deskId) out.set(e.deskId, e);
  return out;
}
