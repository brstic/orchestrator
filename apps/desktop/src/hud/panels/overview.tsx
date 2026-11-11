import { useMemo, useState, type ReactNode } from 'react';
import type { CommandResult, CompanyStats } from '@orchestrator/contracts';
import { formatDuration } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Progress, Stat, Tabs, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { activityOf, currentTaskOf, sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { api } from '../../lib/api.ts';
import { act } from '../core.tsx';
import { ClaudeAccounts, Portfolio, Timeline, Usage } from './ceo.tsx';
import { registerPanel } from './index.tsx';
import { ActivityBadge, HostLabel, NOT_AVAILABLE, attentionOf, byName, fmtDateTime, fmtInt, humanize, isLive, isWorking, onActivate, openNotificationTarget, useTick, type PanelProps } from './company-shared.tsx';
import { needsYou } from '../../lib/attention.ts';

interface AttentionItem {
  key: string;
  tone: Tone;
  tag: string;
  text: ReactNode;
  sub?: string;
  when?: string | null;
  go: () => void;
}

/** What needs you, by the one definition the Inbox and its button use (`lib/attention.ts`). */
function useAttention(): AttentionItem[] {
  const employees = useOffice((s) => s.employees);
  const questions = useOffice((s) => s.questions);
  const notifications = useOffice((s) => s.notifications);
  const { questions: open, stuck } = useMemo(() => needsYou(questions, notifications), [questions, notifications]);
  return useMemo(() => {
    const st = useOffice.getState();
    const out: AttentionItem[] = [];

    for (const q of open) {
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

    // Whoever is stuck until a person acts: the same notifications the Inbox lists under "Needs you".
    for (const n of stuck) {
      out.push({
        key: `n:${n.id}`,
        tone: n.severity === 'critical' ? 'bad' : 'warn',
        tag: humanize(n.kind).toLowerCase(),
        text: n.title,
        sub: n.body || undefined,
        when: n.createdAt,
        go: () => void openNotificationTarget(n),
      });
    }
    return out;
  }, [employees, open, stuck]);
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

type CompanyTab = 'now' | 'projects' | 'usage' | 'history' | 'record';

/**
 * The company in one window: what needs you and what everyone is doing, the projects, how much Claude is left,
 * what happened, and the record. (The CEO desk in the office opens the same window.)
 */
function OverviewPanel({ arg, onClose }: PanelProps) {
  const [tab, setTab] = useState<CompanyTab>(arg === 'projects' || arg === 'usage' || arg === 'history' || arg === 'record' ? arg : 'now');
  const [away, setAway] = useState<CommandResult | null>(null);
  const [busy, setBusy] = useState(false);
  const summarize = async () => {
    setBusy(true);
    const res = await act(() => api<CommandResult>('POST', '/commands/execute', { input: 'summarize what happened while I was away' }));
    setBusy(false);
    if (res) setAway(res);
  };
  const employees = useOffice((s) => s.employees);
  const sessions = useOffice((s) => s.sessions);
  const hostsById = useOffice((s) => s.hosts);
  const tasks = useOffice((s) => s.tasks);
  const questions = useOffice((s) => s.questions);
  const milestones = useOffice((s) => s.milestones);
  const company = useOffice((s) => s.company);
  const settings = useOffice((s) => s.settings);
  const attention = useAttention();
  const proposed = useOffice((st) => Object.values(st.tasks).filter((t) => !t.released && t.status !== 'DONE').length);
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

  const summary = [`${working} of ${team.length} working`, inProgress ? `${inProgress} in progress` : '', inReview ? `${inReview} in review` : '', blocked ? `${blocked} blocked` : '', openQuestions ? `${openQuestions} waiting for your answer` : '', hosts.length ? `${hostsOnline}/${hosts.length} machines online` : ''].filter(Boolean).join(' · ');

  return (
    <Window
      title={settings?.companyName || 'Company'}
      subtitle={summary}
      onClose={onClose}
      width={1120}
      flush
      actions={
        tab === 'history' ? (
          <Button small variant="primary" onClick={summarize} disabled={busy}>
            {busy ? 'Summarising…' : 'What happened while I was away'}
          </Button>
        ) : undefined
      }
    >
      <Tabs<CompanyTab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'now', label: 'Now', count: attention.length || undefined },
          { id: 'projects', label: 'Projects' },
          { id: 'usage', label: 'Claude' },
          { id: 'history', label: 'History' },
          ...(settings?.gamification !== false ? [{ id: 'record' as const, label: 'Record' }] : []),
        ]}
      />
      <div className="pc-tabbody">
        {tab === 'now' && (
          <div className="col" style={{ gap: 16 }}>
        <div>
          <div className="section-title">Needs you{attention.length ? ` (${attention.length})` : ''}</div>
          {attention.length === 0 ? (
            <div className="card small muted">Nothing needs you right now.</div>
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
          {proposed > 0 && (
            <button className="pc-rowbtn small muted" style={{ marginTop: 6 }} onClick={() => useOffice.getState().openPanel('tasks')}>
              {proposed} proposed task{proposed === 1 ? '' : 's'} in the backlog {proposed === 1 ? 'waits' : 'wait'} for you to release {proposed === 1 ? 'it' : 'them'} — open Tasks
            </button>
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
                              <div className="row" style={{ gap: 6 }} title={task.progress.note ?? 'Progress reported by the employee'}>
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
          </div>
        )}
        {tab === 'projects' && <Portfolio />}
        {tab === 'usage' && (
          <div className="col" style={{ gap: 14 }}>
            <ClaudeAccounts />
            <details className="pc-details">
              <summary>Tokens used by the sessions</summary>
              <Usage untitled />
            </details>
          </div>
        )}
        {tab === 'history' && (
          <div className="col" style={{ gap: 14 }}>
            {away && (
              <div className="card col" style={{ gap: 6 }}>
                <div className="row">
                  <span className="strong grow">{away.answer?.title ?? 'While you were away'}</span>
                  <Button small variant="ghost" onClick={() => setAway(null)}>
                    Close summary
                  </Button>
                </div>
                {away.answer?.lines.length ? away.answer.lines.map((l, i) => <div key={i} className="small pre">{l}</div>) : <div className="small muted">Nothing was recorded.</div>}
              </div>
            )}
            <Timeline onClose={onClose} />
          </div>
        )}
        {tab === 'record' && (
          <div className="col" style={{ gap: 16 }}>
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
        )}
      </div>
    </Window>
  );
}

registerPanel('overview', OverviewPanel);
// The CEO desk is the same window.
registerPanel('ceo', OverviewPanel);
