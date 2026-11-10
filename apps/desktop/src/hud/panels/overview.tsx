import { useMemo, useState, type ReactNode } from 'react';
import type { CompanyStats } from '@orchestrator/contracts';
import { formatDuration } from '@orchestrator/contracts';
import { Avatar, Badge, Empty, Progress, Stat, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { activityOf, currentTaskOf, sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { registerPanel } from './index.tsx';
import { ActivityBadge, HostLabel, NOT_AVAILABLE, attentionOf, byName, fmtDateTime, fmtInt, humanize, isLive, isWorking, onActivate, useTick, type PanelProps } from './company-shared.tsx';

interface AttentionItem {
  key: string;
  tone: Tone;
  tag: string;
  text: ReactNode;
  sub?: string;
  when?: string | null;
  go: () => void;
}

/** Everything in this list is derived from recorded state; nothing is a guess about what might be wrong. */
function useAttention(): AttentionItem[] {
  const employees = useOffice((s) => s.employees);
  const sessions = useOffice((s) => s.sessions);
  const hosts = useOffice((s) => s.hosts);
  const tasks = useOffice((s) => s.tasks);
  const questions = useOffice((s) => s.questions);
  return useMemo(() => {
    const st = useOffice.getState();
    const out: AttentionItem[] = [];
    const allTasks = Object.values(tasks);
    const team = Object.values(employees).filter((e) => !e.archived);

    for (const q of Object.values(questions)
      .filter((x) => x.status === 'open')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const who = q.employeeId ? (employees[q.employeeId]?.name ?? 'An employee') : 'Orchestrator';
      out.push({
        key: `q:${q.id}`,
        tone: 'warn',
        tag: q.kind === 'permission' ? 'approval' : humanize(q.kind),
        text: (
          <>
            <span className="strong">{who}</span> {q.kind === 'permission' ? 'asks for approval' : 'asks'}: {q.text}
          </>
        ),
        when: q.createdAt,
        go: () => st.openPanel('question', q.id),
      });
    }

    for (const t of allTasks.filter((x) => x.status === 'BLOCKED')) {
      out.push({
        key: `b:${t.id}`,
        tone: 'bad',
        tag: 'blocked',
        text: (
          <>
            <span className="mono muted">{t.key}</span> {t.title}
          </>
        ),
        sub: t.blockedReason ?? 'No reason was recorded.',
        when: t.updatedAt,
        go: () => st.openPanel('task', t.id),
      });
    }

    // In review, with no employee review task still open: the review is waiting on the owner.
    for (const t of allTasks.filter((x) => x.status === 'REVIEW')) {
      const reviewing = allTasks.some((r) => r.kind === 'review' && r.reviewOf === t.id && r.status !== 'DONE');
      if (reviewing) continue;
      out.push({
        key: `r:${t.id}`,
        tone: 'info',
        tag: 'review',
        text: (
          <>
            <span className="mono muted">{t.key}</span> {t.title}
          </>
        ),
        sub: 'In review and no employee is reviewing it — it waits for your verdict.',
        when: t.updatedAt,
        go: () => st.openPanel('task', t.id),
      });
    }

    for (const e of team) {
      const task = currentTaskOf(tasks, e.id);
      if (!task) continue;
      const session = sessionOfEmployee(sessions, e.id);
      if (isLive(session)) continue;
      const unobservable = session?.status === 'host_offline';
      out.push({
        key: `s:${e.id}`,
        tone: unobservable ? 'warn' : 'bad',
        tag: unobservable ? 'not observable' : 'session down',
        text: (
          <>
            <span className="strong">{e.name}</span> {unobservable ? 'cannot be observed' : 'has no live session'} while <span className="mono muted">{task.key}</span> is in progress
          </>
        ),
        sub: unobservable ? 'Their machine is offline. The session keeps running in tmux and reappears when the machine reconnects.' : session ? `Last session: ${humanize(session.status)}${session.exitReason ? ` — ${session.exitReason}` : ''}` : 'They have never had a session.',
        when: session?.endedAt ?? null,
        go: () => st.openPanel('employee', `${e.id}:session`),
      });
    }

    for (const h of Object.values(hosts).filter((x) => x.status === 'offline')) {
      const staff = team.filter((e) => e.hostId === h.id);
      if (!staff.length) continue;
      out.push({
        key: `h:${h.id}`,
        tone: 'bad',
        tag: 'machine offline',
        text: (
          <>
            <span className="strong">{h.name}</span> is offline
          </>
        ),
        sub: `${staff.length} employee${staff.length === 1 ? '' : 's'} assigned: ${staff.map((e) => e.name).join(', ')}`,
        when: h.lastSeenAt,
        go: () => st.openPanel('hosts'),
      });
    }

    const proposed = allTasks.filter((t) => !t.released && t.status !== 'DONE').length;
    if (proposed) {
      out.push({
        key: 'proposed',
        tone: 'info',
        tag: 'proposed',
        text: (
          <>
            <span className="strong">{proposed}</span> proposed task{proposed === 1 ? '' : 's'} not released yet
          </>
        ),
        sub: 'Unreleased tasks are not scheduled until you give the go-ahead.',
        go: () => st.openPanel('tasks'),
      });
    }
    return out;
  }, [employees, sessions, hosts, tasks, questions]);
}

const COMPANY_STATS: Array<{ key: keyof CompanyStats; label: string }> = [
  { key: 'projectsDelivered', label: 'Projects delivered' },
  { key: 'tasksCompleted', label: 'Tasks verified done' },
  { key: 'bugsResolved', label: 'Bugs resolved' },
  { key: 'testsPassed', label: 'Verifications passed' },
  { key: 'verificationsRun', label: 'Verifications run' },
  { key: 'reviewsCompleted', label: 'Reviews completed' },
  { key: 'mergesSucceeded', label: 'Merges' },
  { key: 'mergeConflicts', label: 'Merge conflicts' },
  { key: 'questionsAnswered', label: 'Questions answered' },
  { key: 'releases', label: 'Successful releases' },
  { key: 'deployments', label: 'Deployments' },
  { key: 'debtReduced', label: 'Debt tasks paid down' },
];

function OverviewPanel({ onClose }: PanelProps) {
  const employees = useOffice((s) => s.employees);
  const sessions = useOffice((s) => s.sessions);
  const hostsById = useOffice((s) => s.hosts);
  const tasks = useOffice((s) => s.tasks);
  const questions = useOffice((s) => s.questions);
  const milestones = useOffice((s) => s.milestones);
  const company = useOffice((s) => s.company);
  const settings = useOffice((s) => s.settings);
  const attention = useAttention();
  const [search, setSearch] = useState('');
  useTick(5000);

  const team = useMemo(() => Object.values(employees).filter((e) => !e.archived).sort(byName), [employees]);
  const rows = team.map((e) => {
    const session = sessionOfEmployee(sessions, e.id);
    const activity = activityOf(session);
    return { e, session, activity, task: currentTaskOf(tasks, e.id), attention: attentionOf(e.id, activity, questions, tasks) };
  });
  const needle = search.trim().toLowerCase();
  const shown = rows.filter((r) => !needle || `${r.e.name} ${r.e.title} ${r.e.department} ${r.task?.key ?? ''} ${r.task?.title ?? ''} ${r.activity}`.toLowerCase().includes(needle));

  const allTasks = Object.values(tasks);
  const working = rows.filter((r) => isWorking(r.activity)).length;
  const inProgress = allTasks.filter((t) => t.status === 'IN_PROGRESS').length;
  const inReview = allTasks.filter((t) => t.status === 'REVIEW').length;
  const blocked = allTasks.filter((t) => t.status === 'BLOCKED').length;
  const openQuestions = Object.values(questions).filter((q) => q.status === 'open').length;
  const hosts = Object.values(hostsById).filter((h) => h.status !== 'revoked');
  const hostsOnline = hosts.filter((h) => h.status === 'online').length;
  const go = (id: string) => {
    useOffice.getState().focusEmployee(id);
    onClose();
  };
  const rate = company?.reviewCompletionRate;

  return (
    <Window title="Company overview" subtitle={settings?.companyName ?? undefined} onClose={onClose} width={1120}>
      <div className="col" style={{ gap: 16 }}>
        <div className="pc-stats">
          <Stat label="Working" value={`${working} / ${team.length}`} sub="employees doing something now" tone={working ? 'info' : undefined} />
          <Stat label="In progress" value={inProgress} sub="tasks" />
          <Stat label="In review" value={inReview} sub="tasks" />
          <Stat label="Blocked" value={blocked} sub="tasks" tone={blocked ? 'bad' : undefined} />
          <Stat label="Open questions" value={openQuestions} sub="waiting on you" tone={openQuestions ? 'warn' : undefined} />
          <Stat label="Machines online" value={`${hostsOnline} / ${hosts.length}`} tone={hosts.length && hostsOnline < hosts.length ? 'warn' : undefined} />
        </div>

        <div>
          <div className="section-title">Needs your attention{attention.length ? ` (${attention.length})` : ''}</div>
          {attention.length === 0 ? (
            <div className="card small muted">Nothing needs you right now: no open questions, no blocked tasks, no reviews waiting on you, and every machine with employees is online.</div>
          ) : (
            <div className="list">
              {attention.map((a) => (
                <button key={a.key} className="pc-rowbtn" onClick={a.go}>
                  <Badge tone={a.tone}>{a.tag}</Badge>
                  <span className="grow">
                    <span className="truncate" style={{ display: 'block' }}>
                      {a.text}
                    </span>
                    {a.sub && (
                      <span className="small muted truncate" style={{ display: 'block' }}>
                        {a.sub}
                      </span>
                    )}
                  </span>
                  {a.when && <span className="small faint pc-nowrap">{timeAgo(a.when)}</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <div className="section-title" style={{ margin: 0 }}>
              Everyone
            </div>
            <span className="grow" />
            <input style={{ width: 260 }} value={search} onChange={(ev) => setSearch(ev.target.value)} placeholder="Search people, tasks or states…" aria-label="Search employees" />
          </div>
          {team.length === 0 ? (
            <Empty title="No employees yet">Hire someone from the Team panel.</Empty>
          ) : shown.length === 0 ? (
            <div className="small muted">No employee matches “{search}”.</div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>State</th>
                  <th>Doing</th>
                  <th>Task</th>
                  <th>Machine</th>
                  <th>In this state</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ e, session, activity, task, attention: attn }) => {
                  const live = isLive(session);
                  return (
                    <tr key={e.id} className="tbl-click" tabIndex={0} onClick={() => go(e.id)} onKeyDown={onActivate(() => go(e.id))} title={`Go to ${e.name}'s desk`}>
                      <td>
                        <div className="row pc-cell-main">
                          <Avatar appearance={e.appearance} size={28} offline={!live} />
                          <div className="grow">
                            <div className="strong truncate">{e.name}</div>
                            <div className="small muted truncate">{e.title}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <ActivityBadge activity={activity} needsYou={attn === 'needs'} />
                      </td>
                      <td style={{ maxWidth: 240 }}>
                        <div className="small mono muted truncate" title={session?.activityDetail ?? undefined}>
                          {live && session?.activityDetail ? session.activityDetail : '—'}
                        </div>
                      </td>
                      <td style={{ maxWidth: 260 }}>
                        {task ? (
                          <div className="col" style={{ gap: 3 }}>
                            <div className="small truncate" title={task.title}>
                              <span className="mono muted">{task.key}</span> {task.title}
                            </div>
                            {task.progress.percent != null ? (
                              <div className="row" style={{ gap: 6 }} title={task.progress.note ?? 'Progress reported by the agent'}>
                                <Progress value={task.progress.percent} />
                                <span className="small mono muted">{Math.round(task.progress.percent)}%</span>
                              </div>
                            ) : (
                              <span className="small faint">no progress reported</span>
                            )}
                          </div>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td>
                        <HostLabel host={e.hostId ? hostsById[e.hostId] : undefined} />
                      </td>
                      <td className="small mono muted pc-nowrap">{live && session ? formatDuration(Math.max(0, Date.now() - Date.parse(session.activitySince))) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {settings?.gamification !== false && (
          <>
            {milestones.length > 0 && (
              <div>
                <div className="section-title">
                  Milestones · {milestones.filter((m) => m.unlockedAt).length} of {milestones.length} reached
                </div>
                <div className="pc-milestones">
                  {milestones.map((m) => (
                    <div key={m.key} className={`card col ${m.unlockedAt ? '' : 'pc-milestone-locked'}`} style={{ gap: 4, padding: 10 }}>
                      <div className="row">
                        <span className="strong grow truncate">{m.title}</span>
                        <Badge tone={m.unlockedAt ? 'good' : 'muted'}>{m.unlockedAt ? 'reached' : 'locked'}</Badge>
                      </div>
                      <div className="small muted">{m.description}</div>
                      {m.unlocks && (
                        <div className="small">
                          {m.unlockedAt ? 'Unlocked' : 'Unlocks'}: {humanize(m.unlocks)}
                        </div>
                      )}
                      <div className="small faint">{m.unlockedAt ? fmtDateTime(m.unlockedAt) : 'Not reached yet'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {company && (
              <div>
                <div className="section-title">Company record — counted from verified work</div>
                <div className="pc-stats">
                  {COMPANY_STATS.map((c) => (
                    <Stat key={c.key} label={c.label} value={fmtInt(company[c.key] as number)} />
                  ))}
                  <Stat label="Review completion" value={rate == null ? <span className="muted" style={{ fontSize: 14 }}>{NOT_AVAILABLE}</span> : `${Math.round(rate <= 1 ? rate * 100 : rate)}%`} sub={company.reviewsRequested ? `${fmtInt(company.reviewsCompleted)} of ${fmtInt(company.reviewsRequested)} requested` : undefined} />
                  <Stat
                    label="Time saved"
                    value={company.agentWorkMs ? `${(company.agentWorkMs / 3600_000).toFixed(company.agentWorkMs < 36_000_000 ? 1 : 0)} h` : <span className="muted" style={{ fontSize: 14 }}>{NOT_AVAILABLE}</span>}
                    sub="worked by employees on tasks that passed verification"
                  />
                  <Stat
                    label="Infrastructure reliability"
                    value={company.infrastructureReliability == null ? <span className="muted" style={{ fontSize: 14 }}>{NOT_AVAILABLE}</span> : `${Math.round(company.infrastructureReliability * 1000) / 10}%`}
                    sub={company.sessionsStarted ? `${fmtInt(company.sessionsLost)} of ${fmtInt(company.sessionsStarted)} sessions lost · ${fmtInt(company.hostDisconnects)} machine disconnects` : undefined}
                    tone={company.infrastructureReliability != null && company.infrastructureReliability < 0.9 ? 'warn' : undefined}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Window>
  );
}
registerPanel('overview', OverviewPanel);
