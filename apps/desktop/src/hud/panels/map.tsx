import { useMemo } from 'react';
import type { Desk, Employee } from '@orchestrator/contracts';
import { ACTIVITY_LABEL, DESK_SIZE, deskSeat } from '@orchestrator/contracts';
import { Button, Window } from '@orchestrator/ui';
import { activityOf, sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { registerPanel } from './index.tsx';
import { OfficeSvg, attentionOf, byName, isWorking, onActivate, useUnlocked, type PanelProps } from './company-shared.tsx';

type MapState = 'working' | 'needs' | 'blocked' | 'idle' | 'unknown' | 'offline';

const STATE: Record<MapState, { label: string; fill: string; stroke?: string }> = {
  working: { label: 'Working', fill: '#6ea8ff' },
  needs: { label: 'Needs you', fill: '#ffb020' },
  blocked: { label: 'Blocked', fill: '#ff5d73' },
  idle: { label: 'Idle', fill: '#9aa3b2' },
  unknown: { label: 'Unknown — cannot be observed', fill: 'transparent', stroke: '#9aa3b2' },
  offline: { label: 'Offline', fill: '#3a4356' },
};
const LEGEND: MapState[] = ['working', 'needs', 'blocked', 'idle', 'unknown', 'offline'];

function stateOf(activity: string, attention: 'needs' | 'blocked' | null): MapState {
  if (attention === 'needs') return 'needs';
  if (attention === 'blocked') return 'blocked';
  if (activity === 'offline') return 'offline';
  if (activity === 'unknown') return 'unknown';
  return isWorking(activity) ? 'working' : 'idle';
}

/**
 * Desks in the same row sit closer together than a name is wide, so every
 * second label in a row is pushed one line further out.
 */
function labelLevels(desks: Desk[]): Map<string, number> {
  const rows = new Map<string, Desk[]>();
  for (const d of desks) {
    const key = deskSeat(d).z.toFixed(1);
    rows.set(key, [...(rows.get(key) ?? []), d]);
  }
  const out = new Map<string, number>();
  for (const row of rows.values()) row.sort((a, b) => a.x - b.x).forEach((d, i) => out.set(d.id, i % 2));
  return out;
}

function MapPanel({ onClose }: PanelProps) {
  const layout = useOffice((s) => s.layout);
  const employees = useOffice((s) => s.employees);
  const sessions = useOffice((s) => s.sessions);
  const tasks = useOffice((s) => s.tasks);
  const questions = useOffice((s) => s.questions);
  const projectsById = useOffice((s) => s.projects);
  const hostsById = useOffice((s) => s.hosts);
  const filter = useOffice((s) => s.filter);
  const setFilter = useOffice((s) => s.setFilter);
  const unlocked = useUnlocked();
  const levels = useMemo(() => labelLevels(layout?.desks ?? []), [layout]);

  if (!layout) return null;
  const desksById = new Map(layout.desks.map((d) => [d.id, d]));
  // (The foreman has no desk and is never "unseated": it walks the floor.)
  const team = Object.values(employees)
    .filter((e) => !e.archived && e.roleKey !== 'foreman')
    .sort(byName);
  const people = team.map((e) => {
    const activity = activityOf(sessionOfEmployee(sessions, e.id));
    const state = stateOf(activity, attentionOf(e.id, activity, questions, tasks));
    const dimmed = (!!filter.projectId && e.projectId !== filter.projectId) || (!!filter.hostId && e.hostId !== filter.hostId) || (!!filter.employeeId && e.id !== filter.employeeId);
    return { e, activity, state, dimmed, desk: e.deskId ? desksById.get(e.deskId) : undefined };
  });
  const seated = people.filter((p) => p.desk);
  const unseated = people.filter((p) => !p.desk);
  const filtered = !!filter.projectId || !!filter.hostId || !!filter.employeeId;
  const matching = people.filter((p) => !p.dimmed).length;
  const go = (e: Employee) => {
    useOffice.getState().focusEmployee(e.id);
    onClose();
  };
  const counts = LEGEND.map((s) => ({ s, n: people.filter((p) => p.state === s).length }));

  return (
    <Window title="Office map" subtitle="Click someone to walk to their desk" onClose={onClose} width={1000}>
      <div className="col" style={{ gap: 10 }}>
        <div className="pc-toolbar" style={{ marginBottom: 0 }}>
          <select value={filter.projectId ?? ''} onChange={(ev) => setFilter({ projectId: ev.target.value || null })} aria-label="Filter by project">
            <option value="">All projects</option>
            {Object.values(projectsById)
              .filter((p) => p.status !== 'archived' || p.id === filter.projectId)
              .sort(byName)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <select value={filter.hostId ?? ''} onChange={(ev) => setFilter({ hostId: ev.target.value || null })} aria-label="Filter by machine">
            <option value="">All machines</option>
            {Object.values(hostsById)
              .filter((h) => h.status !== 'revoked' || h.id === filter.hostId)
              .sort(byName)
              .map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
          </select>
          <select value={filter.employeeId ?? ''} onChange={(ev) => setFilter({ employeeId: ev.target.value || null })} aria-label="Filter by employee">
            <option value="">All employees</option>
            {people
              .map((p) => p.e)
              .sort(byName)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </select>
          <Button small disabled={!filtered} onClick={() => setFilter({ projectId: null, hostId: null, employeeId: null })}>
            Clear filter
          </Button>
          <span className="small muted">{filtered ? `${matching} of ${people.length} match — the others are dimmed here and in the 3D office.` : 'A filter also dims everyone else in the 3D office.'}</span>
        </div>

        <OfficeSvg layout={layout} unlocked={unlocked} label="Office map">
          {layout.desks.map((d) => (
            <rect key={d.id} className="pc-map-desk" x={d.x - DESK_SIZE.w / 2} y={d.z - DESK_SIZE.d / 2} width={DESK_SIZE.w} height={DESK_SIZE.d} rx={0.1} />
          ))}
          {seated.map(({ e, activity, state, dimmed, desk }) => {
            const seat = deskSeat(desk!);
            // The chair is on the far side of the desk; the label goes further out the same way.
            const away = seat.z < desk!.z ? -1 : 1;
            const reach = 0.72 + (levels.get(desk!.id) ?? 0) * 0.62;
            const label = `${e.name} — ${e.title} — ${ACTIVITY_LABEL[activity] ?? activity}`;
            const look = STATE[state];
            return (
              <g key={e.id} className="pc-map-person" role="button" tabIndex={0} aria-label={`${label}. Go to their desk.`} opacity={dimmed ? 0.22 : 1} onClick={() => go(e)} onKeyDown={onActivate(() => go(e))}>
                <title>{label}</title>
                <circle cx={seat.x} cy={seat.z} r={0.75} fill="transparent" />
                <circle cx={seat.x} cy={seat.z} r={0.4} fill={look.fill} stroke={look.stroke ?? 'rgba(0,0,0,0.5)'} strokeWidth={look.stroke ? 0.12 : 0.06} strokeDasharray={state === 'unknown' ? '0.18 0.12' : undefined} />
                <text className="pc-map-name" x={seat.x} y={seat.z + away * reach + (away > 0 ? 0.42 : 0)} textAnchor="middle">
                  {e.name.split(/\s+/)[0]}
                </text>
              </g>
            );
          })}
        </OfficeSvg>

        <div className="row row-wrap">
          <div className="pc-legend grow">
            {counts.map(({ s, n }) => (
              <span key={s}>
                <i style={{ background: STATE[s].fill, border: STATE[s].stroke ? `2px dashed ${STATE[s].stroke}` : undefined }} />
                {STATE[s].label} <span className="faint">{n}</span>
              </span>
            ))}
          </div>
          <span className="small faint">States come from real session signals; “unknown” means it cannot be observed.</span>
        </div>

        {unseated.length > 0 && (
          <div className="row row-wrap small">
            <span className="muted">Without a desk:</span>
            {unseated.map(({ e }) => (
              <button key={e.id} className="btn btn-ghost btn-sm" onClick={() => useOffice.getState().openPanel('employee', `${e.id}:desk`)}>
                {e.name}
              </button>
            ))}
          </div>
        )}
        {team.length === 0 && <div className="small muted">Nobody works here yet — the desks are empty.</div>}
      </div>
    </Window>
  );
}
registerPanel('map', MapPanel);
