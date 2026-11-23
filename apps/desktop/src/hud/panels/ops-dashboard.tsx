import { useMemo } from 'react';
import { Badge, timeAgo } from '@orchestrator/ui';
import { useOffice } from '../../lib/store.ts';
import { checkHealth } from '../../lib/check-health.ts';
import { fmtBytes, hostDotClass } from './company-shared.tsx';

const NONE = <div className="small faint">Nothing recorded yet.</div>;

/**
 * The operations room's dashboard: builds, deployments, git activity, projects, resources and
 * warnings. Every row is something that was measured or recorded — verification runs by the
 * office, commands seen in real terminals, merges it performed, figures the machines report.
 */
export function OpsDashboard() {
  const tasks = useOffice((s) => s.tasks);
  const events = useOffice((s) => s.events);
  const projects = useOffice((s) => s.projects);
  const employees = useOffice((s) => s.employees);
  const hostsById = useOffice((s) => s.hosts);
  const sessions = useOffice((s) => s.sessions);
  const notifications = useOffice((s) => s.notifications);
  const openPanel = useOffice((s) => s.openPanel);
  // What waits for an owner, and how owners approve, is theirs to read (a visitor's tasks carry no evidence anyway).
  const owner = useOffice((s) => s.me?.role === 'owner');

  const builds = useMemo(
    () =>
      Object.values(tasks)
        .filter((t) => t.evidence.verification)
        .sort((a, b) => b.evidence.verification!.ts.localeCompare(a.evidence.verification!.ts))
        .slice(0, 8),
    [tasks],
  );
  const deployments = useMemo(() => events.filter((e) => e.type === 'ops.deployment').slice(-8).reverse(), [events]);
  const git = useMemo(() => {
    const rows: Array<{ key: string; ts: string; text: string; tone: 'good' | 'bad' | 'info'; tag: string; taskId: string | null }> = [];
    for (const t of Object.values(tasks)) {
      for (const c of t.evidence.commits) rows.push({ key: `c-${c.sha}`, ts: c.ts, tag: 'commit', tone: 'info', text: `${c.sha.slice(0, 7)} ${c.subject} — ${c.author} (${t.key})`, taskId: t.id });
      if (t.evidence.merge) rows.push({ key: `m-${t.id}`, ts: t.evidence.merge.ts, tag: t.evidence.merge.ok ? 'merge' : 'conflict', tone: t.evidence.merge.ok ? 'good' : 'bad', text: `${t.key} → ${t.evidence.merge.into}${t.evidence.merge.ok ? '' : `: ${t.evidence.merge.detail}`}`, taskId: t.id });
    }
    return rows.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 10);
  }, [tasks]);
  const projectRows = useMemo(
    () =>
      Object.values(projects)
        .filter((p) => p.status !== 'archived')
        .map((p) => {
          const mine = Object.values(tasks).filter((t) => t.projectId === p.id);
          return {
            p,
            people: Object.values(employees).filter((e) => !e.archived && e.projectId === p.id).length,
            active: mine.filter((t) => t.status === 'IN_PROGRESS' || t.status === 'REVIEW').length,
            blocked: mine.filter((t) => t.status === 'BLOCKED').length,
            done: mine.filter((t) => t.status === 'DONE').length,
            total: mine.length,
          };
        })
        .sort((a, b) => b.active - a.active || a.p.name.localeCompare(b.p.name)),
    [projects, tasks, employees],
  );
  const hosts = Object.values(hostsById).filter((h) => h.status !== 'revoked');
  const warnings = useMemo(
    () => Object.values(notifications).filter((n) => !n.resolvedAt && ['host_disconnected', 'host_resources', 'session_lost', 'security', 'merge_conflict', 'test_failure'].includes(n.kind)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8),
    [notifications],
  );

  const health = useMemo(() => checkHealth(tasks), [tasks]);
  const of = (n: number, total: number) => (total ? `${n} of ${total}` : '—');

  return (
    <div className="ops-grid">
      {owner && (
        <section className="card ops-card" data-check-health>
          <div className="section-title">How work is checked — the last {health.days} days</div>
          {health.handedIn === 0 && health.waiting.length === 0 ? (
            NONE
          ) : (
            <>
              <div className="ops-row" title="Code handed in: what the office itself ran on it">
                <span className="grow">Code handed in</span>
                <span className="small muted">
                  {health.handedIn} · tested by the office {health.tested} · only parsed {health.syntaxOnly} · nothing run {health.unchecked}
                </span>
              </div>
              <div className="ops-row" title="A colleague's approval says what they ran or opened (submit_review checked)">
                <span className="grow">Colleagues' approvals that say what was checked</span>
                <span className="small muted">{of(health.peerChecked, health.peerApprovals)}</span>
              </div>
              <div className="ops-row">
                <span className="grow">Sent back at least once</span>
                <span className="small muted">{of(health.sentBack, health.handedIn)}</span>
              </div>
              <div className="ops-row">
                <span className="grow">Approved by an owner with a word said</span>
                <span className="small muted">{of(health.ownerSaid, health.ownerApprovals)}</span>
              </div>
              {health.waiting.map((w) => (
                <button key={w.id} className="ops-row" onClick={() => openPanel('task', w.id)} data-check-waiting={w.key}>
                  <Badge tone={Date.now() - Date.parse(w.since) > 86_400_000 ? 'warn' : 'neutral'}>waits for you</Badge>
                  <span className="grow truncate">
                    <span className="mono muted">{w.key}</span> {w.title}
                  </span>
                  <span className="small faint ops-when">{timeAgo(w.since)}</span>
                </button>
              ))}
            </>
          )}
        </section>
      )}

      <section className="card ops-card">
        <div className="section-title">Build results — verification runs by the office</div>
        {builds.length === 0
          ? NONE
          : builds.map((t) => {
              const v = t.evidence.verification!;
              return (
                <button key={t.id} className="ops-row" onClick={() => openPanel('task', t.id)} title={v.command ?? undefined}>
                  <Badge tone={v.passed ? 'good' : v.passed === false ? 'bad' : 'neutral'}>{v.passed ? 'passed' : v.passed === false ? 'failed' : 'not run'}</Badge>
                  <span className="grow truncate">
                    <span className="mono muted">{t.key}</span> {t.title}
                  </span>
                  <span className="small mono faint truncate" style={{ maxWidth: 160 }}>
                    {v.command ?? 'no command'}
                  </span>
                  <span className="small faint ops-when">{timeAgo(v.ts)}</span>
                </button>
              );
            })}
      </section>

      <section className="card ops-card">
        <div className="section-title">Deployment activity — commands seen in real terminals</div>
        {deployments.length === 0
          ? NONE
          : deployments.map((e) => (
              <div key={e.id} className="ops-row" title={String(e.data.command ?? '')}>
                <Badge tone={e.data.ok ? 'good' : 'bad'}>{e.data.ok ? 'succeeded' : 'failed'}</Badge>
                <Badge tone={e.data.kind === 'release' ? 'info' : 'neutral'}>{String(e.data.kind)}</Badge>
                <span className="grow truncate">
                  {employees[e.employeeId ?? '']?.name ?? 'Someone'} · {String(e.data.what)}
                </span>
                <span className="small mono faint truncate" style={{ maxWidth: 200 }}>
                  {String(e.data.command ?? '')}
                </span>
                <span className="small faint ops-when">{timeAgo(e.ts)}</span>
              </div>
            ))}
      </section>

      <section className="card ops-card">
        <div className="section-title">Git activity — commits and merges measured on the machines</div>
        {git.length === 0
          ? NONE
          : git.map((g) => (
              <button key={g.key} className="ops-row" onClick={() => g.taskId && openPanel('task', g.taskId)}>
                <Badge tone={g.tone}>{g.tag}</Badge>
                <span className="grow truncate small">{g.text}</span>
                <span className="small faint ops-when">{timeAgo(g.ts)}</span>
              </button>
            ))}
      </section>

      <section className="card ops-card">
        <div className="section-title">Current projects</div>
        {projectRows.length === 0
          ? NONE
          : projectRows.map(({ p, people, active, blocked, done, total }) => (
              <button key={p.id} className="ops-row" onClick={() => openPanel('projects', p.id)}>
                <span className="ops-dot" style={{ background: p.color }} />
                <span className="grow truncate strong">{p.name}</span>
                {p.status !== 'active' && <Badge tone="warn">{p.status}</Badge>}
                <span className="small muted">
                  {people} {people === 1 ? 'person' : 'people'} · {active} active{blocked ? ' · ' : ''}
                  {blocked ? <span className="feed-bad">{blocked} blocked</span> : null} · {done}/{total} done
                </span>
              </button>
            ))}
      </section>

      <section className="card ops-card">
        <div className="section-title">Resource usage — measured on each machine</div>
        {hosts.length === 0
          ? NONE
          : hosts.map((h) => {
              const r = h.status === 'online' && h.resources && (h.resources.cpuPercent != null || h.resources.memUsedBytes != null) ? h.resources : null;
              const mem = r && r.memUsedBytes != null && r.memTotalBytes ? r.memUsedBytes / r.memTotalBytes : null;
              const running = Object.values(sessions).filter((s) => s.hostId === h.id && s.status === 'running').length;
              return (
                <div key={h.id} className="ops-row">
                  <span className={hostDotClass(h)} />
                  <span className="strong truncate" style={{ flex: '1 1 90px', minWidth: 70 }} title={h.name}>
                    {h.name}
                  </span>
                  {r ? (
                    <>
                      <Meter label="CPU" value={r.cpuPercent != null ? r.cpuPercent / 100 : null} />
                      <Meter label="Mem" value={mem} note={r.memTotalBytes ? fmtBytes(r.memTotalBytes) : undefined} />
                      <span className="small muted">load {r.loadAvg1 != null ? r.loadAvg1.toFixed(2) : 'n/a'}</span>
                    </>
                  ) : (
                    <span className="small faint grow">{h.status === 'online' ? 'no data yet' : `${h.status} · no data`}</span>
                  )}
                  <span className="small muted" style={{ flex: 'none' }}>
                    {running} session{running === 1 ? '' : 's'}
                  </span>
                </div>
              );
            })}
      </section>

      <section className="card ops-card">
        <div className="section-title">Infrastructure warnings{warnings.length ? ` (${warnings.length})` : ''}</div>
        {warnings.length === 0 ? (
          <div className="small faint">No open warnings: every machine with employees is online, nothing is out of resources, and no session was lost.</div>
        ) : (
          warnings.map((n) => (
            <button key={n.id} className="ops-row" onClick={() => openPanel('notifications')} title={n.body}>
              <Badge tone={n.severity === 'critical' ? 'bad' : 'warn'}>{n.kind.replace(/_/g, ' ')}</Badge>
              <span className="grow truncate">{n.title}</span>
              <span className="small faint ops-when">{timeAgo(n.createdAt)}</span>
            </button>
          ))
        )}
      </section>
    </div>
  );
}

function Meter({ label, value, note }: { label: string; value: number | null; note?: string }) {
  const pct = value == null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span className="ops-meter" title={pct == null ? `${label}: not reported` : `${label}: ${pct}%${note ? ` of ${note}` : ''} (measured)`}>
      <span className="small muted">{label}</span>
      <span className="ops-meter-bar">
        <i style={{ width: `${pct ?? 0}%`, background: pct != null && pct >= 95 ? 'var(--bad, #ff6b6b)' : pct != null && pct >= 80 ? 'var(--warn, #f5b942)' : 'var(--good, #3ddc84)' }} />
      </span>
      <span className="small mono muted" style={{ width: 34, textAlign: 'right' }}>
        {pct == null ? 'n/a' : `${pct}%`}
      </span>
    </span>
  );
}
