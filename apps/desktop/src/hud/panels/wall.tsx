import { useEffect, useMemo, useState } from 'react';
import type { AgentSession } from '@orchestrator/contracts';
import { Avatar, Button, Empty, Window } from '@orchestrator/ui';
import { activityOf, useOffice } from '../../lib/store.ts';
import { TerminalView } from '../../terminal/TerminalView.tsx';
import { registerPanel } from './index.tsx';
import { OpsDashboard } from './ops-dashboard.tsx';
import { ActivityBadge, attentionOf, byName, fmtBytes, hostDotClass, type PanelProps } from './company-shared.tsx';

const LAYOUTS = [
  { id: '2x2', label: '2 × 2', cols: 2, rows: 2 },
  { id: '3x2', label: '3 × 2', cols: 3, rows: 2 },
  { id: '3x3', label: '3 × 3', cols: 3, rows: 3 },
  { id: '4x3', label: '4 × 3', cols: 4, rows: 3 },
] as const;
type LayoutId = (typeof LAYOUTS)[number]['id'];

const PINS_KEY = 'orch.wall.pins';
const LAYOUT_KEY = 'orch.wall.layout';

function readPins(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function readLayout(): LayoutId {
  const v = localStorage.getItem(LAYOUT_KEY);
  return LAYOUTS.some((l) => l.id === v) ? (v as LayoutId) : '3x2';
}

/** Pins follow the employee, so they survive a session restart; unbound sessions are pinned by session. */
function pinKey(s: AgentSession): string {
  return s.employeeId ?? s.id;
}

function WallPanel({ onClose }: PanelProps) {
  const sessions = useOffice((s) => s.sessions);
  const employees = useOffice((s) => s.employees);
  const hostsById = useOffice((s) => s.hosts);
  const tasks = useOffice((s) => s.tasks);
  const questions = useOffice((s) => s.questions);
  const [layoutId, setLayoutId] = useState<LayoutId>(readLayout);
  const [hostId, setHostId] = useState('');
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [pins, setPins] = useState<string[]>(readPins);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<'terminals' | 'operations'>('terminals');

  useEffect(() => {
    try {
      localStorage.setItem(PINS_KEY, JSON.stringify(pins));
    } catch {
      /* storage unavailable: pins last for this window only */
    }
  }, [pins]);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, layoutId);
    } catch {
      /* ignore */
    }
  }, [layoutId]);

  const layout = LAYOUTS.find((l) => l.id === layoutId)!;
  const capacity = layout.cols * layout.rows;
  const hosts = useMemo(() => Object.values(hostsById).filter((h) => h.status !== 'revoked').sort(byName), [hostsById]);

  // Only sessions that are really running: each tile is a live stream from a real tmux pane.
  const ordered = useMemo(() => {
    const pinned = new Set(pins);
    return Object.values(sessions)
      .filter((s) => s.status === 'running' && (!hostId || s.hostId === hostId))
      .map((s) => {
        const employee = s.employeeId ? employees[s.employeeId] : undefined;
        const activity = activityOf(s);
        const attention = employee ? attentionOf(employee.id, activity, questions, tasks) : activity === 'waiting_answer' || activity === 'needs_approval' ? ('needs' as const) : activity === 'blocked' ? ('blocked' as const) : null;
        return { session: s, employee, activity, attention, pinned: pinned.has(pinKey(s)), name: employee?.name ?? s.tmuxSession };
      })
      .filter((t) => !onlyAttention || t.attention)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(!!b.attention) - Number(!!a.attention) || a.name.localeCompare(b.name) || a.session.id.localeCompare(b.session.id));
  }, [sessions, employees, questions, tasks, pins, hostId, onlyAttention]);

  const pages = Math.max(1, Math.ceil(ordered.length / capacity));
  const current = Math.min(page, pages - 1);
  const big = enlarged ? ordered.find((t) => t.session.id === enlarged) : undefined;
  // Never mount more terminals than the layout holds; an enlarged tile is the only one mounted.
  const tiles = big ? [big] : ordered.slice(current * capacity, current * capacity + capacity);

  const togglePin = (s: AgentSession) => {
    const key = pinKey(s);
    setPins((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  };

  const allTasks = Object.values(tasks);
  const counts = {
    inProgress: allTasks.filter((t) => t.status === 'IN_PROGRESS').length,
    review: allTasks.filter((t) => t.status === 'REVIEW').length,
    blocked: allTasks.filter((t) => t.status === 'BLOCKED').length,
    questions: Object.values(questions).filter((q) => q.status === 'open').length,
  };
  const runningTotal = Object.values(sessions).filter((s) => s.status === 'running').length;
  const st = useOffice.getState();

  return (
    <Window title="Terminals" subtitle={`${runningTotal} running session${runningTotal === 1 ? '' : 's'} · watching only`} onClose={onClose} width="96vw" flush>
      <div className="pc-wall">
        <div className="pc-wall-bar">
          <div className="seg" role="tablist" aria-label="What the wall shows">
            <button role="tab" aria-selected={view === 'terminals'} className={view === 'terminals' ? 'seg-on' : ''} onClick={() => setView('terminals')}>
              Terminals
            </button>
            <button role="tab" aria-selected={view === 'operations'} className={view === 'operations' ? 'seg-on' : ''} onClick={() => setView('operations')}>
              Operations
            </button>
          </div>
          {view === 'operations' && <span className="small muted grow">Builds, deployments, git, projects, resources and warnings — all from recorded facts.</span>}
          {view === 'terminals' && (<>
          <label className="row small">
            <span className="muted">Layout</span>
            <select
              value={layoutId}
              onChange={(ev) => {
                setLayoutId(ev.target.value as LayoutId);
                setPage(0);
              }}
            >
              {LAYOUTS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="row small">
            <span className="muted">Machine</span>
            <select
              value={hostId}
              onChange={(ev) => {
                setHostId(ev.target.value);
                setPage(0);
              }}
            >
              <option value="">All machines</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <label className="check small" style={{ alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={onlyAttention}
              onChange={(ev) => {
                setOnlyAttention(ev.target.checked);
                setPage(0);
              }}
              style={{ marginTop: 0 }}
            />
            Only needing attention
          </label>
          <span className="grow" />
          {big ? (
            <Button small onClick={() => setEnlarged(null)}>
              Back to the wall
            </Button>
          ) : (
            <>
              <span className="small muted">
                {ordered.length === 0 ? 'No sessions to show' : `Showing ${current * capacity + 1}–${current * capacity + tiles.length} of ${ordered.length}`}
                {ordered.length > capacity ? ' · pinned first' : ''}
              </span>
              {pages > 1 && (
                <>
                  <Button small disabled={current === 0} onClick={() => setPage(current - 1)} aria-label="Previous page">
                    ‹
                  </Button>
                  <Button small disabled={current >= pages - 1} onClick={() => setPage(current + 1)} aria-label="Next page">
                    ›
                  </Button>
                </>
              )}
            </>
          )}
          </>)}
        </div>

        <div className="pc-wall-grid">
          {view === 'operations' ? (
            <OpsDashboard />
          ) : tiles.length === 0 ? (
            <Empty title={onlyAttention ? 'Nobody needs you right now' : 'No running sessions'}>
              {onlyAttention ? 'No running session is waiting on a decision or blocked.' : 'Start an employee’s session, or attach an existing tmux session in the server room, and its real terminal appears here.'}
            </Empty>
          ) : (
            <div
              className="wall"
              style={{
                gridTemplateColumns: `repeat(${big ? 1 : layout.cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${big ? 1 : layout.rows}, minmax(0, 1fr))`,
              }}
            >
              {tiles.map(({ session, employee, activity, attention, pinned, name }) => (
                <div key={session.id} className={`wall-tile ${attention ? 'pc-tile-attn' : ''}`}>
                  <div className="wall-tile-head">
                    {employee && <Avatar appearance={employee.appearance} size={20} />}
                    <span className="strong truncate" title={`${name} · ${session.tmuxSession} on ${hostsById[session.hostId]?.name ?? 'unknown machine'} · ${session.cwd}`}>
                      {name}
                    </span>
                    {!employee && <span className="faint">unbound</span>}
                    <ActivityBadge activity={activity} needsYou={attention === 'needs'} />
                    <span className="grow truncate small mono faint">{session.activityDetail ?? ''}</span>
                    <button className={`btn btn-sm pc-tile-btn ${pinned ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={pinned} onClick={() => togglePin(session)} title={pinned ? 'Unpin from the front of the wall' : 'Keep at the front of the wall'}>
                      {pinned ? 'Pinned' : 'Pin'}
                    </button>
                    <button className="btn btn-ghost btn-sm pc-tile-btn" disabled={!employee} onClick={() => employee && st.enterWorkstation(employee.id)} title={employee ? 'Sit at this workstation: observe, or take control' : 'Bind this session to an employee first (server room)'}>
                      Open terminal
                    </button>
                    <button className="btn btn-ghost btn-sm pc-tile-btn" aria-pressed={!!big} onClick={() => setEnlarged(big ? null : session.id)} title={big ? 'Back to the wall' : 'Enlarge this terminal'}>
                      {big ? 'Restore' : 'Enlarge'}
                    </button>
                  </div>
                  <TerminalView key={session.id} sessionId={session.id} interactive={false} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="pc-wall-foot">
          {hosts.map((h) => {
            const res = h.status === 'online' ? h.resources : null;
            // A report that carries no numbers is "no data", not "measured".
            const r = res && (res.cpuPercent != null || res.memUsedBytes != null) ? res : null;
            const mem = r && r.memUsedBytes != null && r.memTotalBytes ? `${Math.round((r.memUsedBytes / r.memTotalBytes) * 100)}% of ${fmtBytes(r.memTotalBytes)}` : null;
            const running = Object.values(sessions).filter((s) => s.hostId === h.id && s.status === 'running').length;
            return (
              <span key={h.id} className="pc-wall-host" title={r ? 'CPU and memory are measured on the machine' : `No data: ${h.name} is ${h.status}`}>
                <span className={hostDotClass(h)} />
                <span className="strong">{h.name}</span>
                {r ? (
                  <span className="muted">
                    CPU {r.cpuPercent != null ? `${Math.round(r.cpuPercent)}%` : 'n/a'} · mem {mem ?? 'n/a'} <span className="faint">(measured)</span>
                  </span>
                ) : (
                  <span className="faint">{h.status === 'online' ? 'no data yet' : `${h.status} · no data`}</span>
                )}
                <span className="muted">
                  · {running} session{running === 1 ? '' : 's'}
                </span>
              </span>
            );
          })}
          <span className="grow" />
          <span className="muted">{counts.inProgress} in progress</span>
          <span className="muted">{counts.review} in review</span>
          <span className={counts.blocked ? 'feed-bad' : 'muted'}>{counts.blocked} blocked</span>
          <button className={`btn btn-sm ${counts.questions ? 'btn-primary' : 'btn-ghost'} pc-tile-btn`} onClick={() => st.openPanel('notifications')}>
            {counts.questions} open question{counts.questions === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </Window>
  );
}
registerPanel('wall', WallPanel);
