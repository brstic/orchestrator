import { useEffect, useMemo, useState } from 'react';
import type { CommandResult, OrchestratorEvent } from '@orchestrator/contracts';
import { Badge, Button, Empty, Progress, Provenance, Stat, Window, clock, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { loadAccounts, useOffice } from '../../lib/store.ts';
import { accountName, limitText } from '../../lib/views.ts';
import { QuestionBody, act } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { NOT_AVAILABLE, eventTone, fmtInt, humanize, isLoudEvent, openNotificationTarget, type PanelProps } from './company-shared.tsx';

function Portfolio() {
  const projectsById = useOffice((s) => s.projects);
  const tasks = useOffice((s) => s.tasks);
  const projects = useMemo(
    () =>
      Object.values(projectsById)
        .filter((p) => p.status !== 'archived')
        .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || a.name.localeCompare(b.name)),
    [projectsById],
  );
  if (projects.length === 0) return <Empty title="No projects yet">Create a project at the project board to see it here.</Empty>;
  return (
    <div className="grid2" style={{ gap: 10 }}>
      {projects.map((p) => {
        // Review tasks are bookkeeping for the work under review, so they do not count as deliverables.
        const ts = Object.values(tasks).filter((t) => t.projectId === p.id && t.kind !== 'review');
        const done = ts.filter((t) => t.status === 'DONE').length;
        const inProgress = ts.filter((t) => t.status === 'IN_PROGRESS').length;
        const blocked = ts.filter((t) => t.status === 'BLOCKED').length;
        const review = ts.filter((t) => t.status === 'REVIEW').length;
        return (
          <button key={p.id} className="card card-click pc-cardbtn col" style={{ gap: 6, borderLeft: `3px solid ${p.color}` }} onClick={() => useOffice.getState().openPanel('projects', p.id)}>
            <span className="row">
              <span className="strong grow truncate">{p.name}</span>
              {p.deliveredAt && (
                <Badge tone="good" title={`Every released task was verified done ${timeAgo(p.deliveredAt)}`}>
                  delivered
                </Badge>
              )}
              <Badge tone={p.status === 'active' ? 'info' : 'muted'}>{p.status}</Badge>
            </span>
            <span className="row" style={{ gap: 8 }}>
              <Progress value={ts.length ? (done / ts.length) * 100 : 0} tone={p.deliveredAt ? 'good' : 'info'} />
              <span className="small mono muted pc-nowrap">
                {done}/{ts.length} done
              </span>
            </span>
            <span className="row row-wrap small" style={{ gap: 10 }}>
              <span className="muted">{inProgress} in progress</span>
              <span className="muted">{review} in review</span>
              <span className={blocked ? 'feed-bad' : 'muted'}>{blocked} blocked</span>
              {ts.length === 0 && <span className="faint">no tasks yet</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Decisions() {
  const questions = useOffice((s) => s.questions);
  const employees = useOffice((s) => s.employees);
  const open = useMemo(
    () =>
      Object.values(questions)
        .filter((q) => q.status === 'open')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [questions],
  );
  const [first, ...rest] = open;
  if (!first) return <div className="card small muted">No decision is waiting on you.</div>;
  return (
    <div className="col">
      <div className="card">
        <QuestionBody key={first.id} q={first} />
      </div>
      {rest.length > 0 && (
        <div className="list">
          {rest.map((q) => (
            <button key={q.id} className="pc-rowbtn" onClick={() => useOffice.getState().openPanel('question', q.id)}>
              <Badge tone="warn">{q.kind === 'permission' ? 'approval' : humanize(q.kind)}</Badge>
              <span className="grow truncate">
                <span className="strong">{q.employeeId ? (employees[q.employeeId]?.name ?? 'An employee') : 'Orchestrator'}</span> {q.text}
              </span>
              <span className="small faint pc-nowrap">{timeAgo(q.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Warnings({ onClose }: { onClose: () => void }) {
  const notifications = useOffice((s) => s.notifications);
  const critical = Object.values(notifications)
    .filter((n) => !n.resolvedAt && n.severity === 'critical')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (critical.length === 0) return null;
  return (
    <div>
      <div className="section-title">High-priority warnings</div>
      <div className="col" style={{ gap: 6 }}>
        {critical.map((n) => (
          <div key={n.id} className="pc-confirm" style={{ padding: 10, gap: 4 }}>
            <div className="row">
              <button className="pc-rowbtn grow" style={{ padding: 0 }} onClick={() => openNotificationTarget(n) && onClose()}>
                <span className="dot dot-bad" />
                <span className="strong grow truncate">{n.title}</span>
              </button>
              <span className="small faint pc-nowrap">{timeAgo(n.createdAt)}</span>
              <Button small variant="ghost" onClick={() => act(() => api('POST', `/notifications/${n.id}/resolve`, {}))}>
                Dismiss
              </Button>
            </div>
            {n.body && <div className="small">{n.body}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Infrastructure() {
  const hostsById = useOffice((s) => s.hosts);
  const sessions = useOffice((s) => s.sessions);
  const hosts = Object.values(hostsById).filter((h) => h.status !== 'revoked');
  const online = hosts.filter((h) => h.status === 'online').length;
  const offline = hosts.length - online;
  const all = Object.values(sessions);
  const running = all.filter((s) => s.status === 'running').length;
  const unobservable = all.filter((s) => s.status === 'host_offline').length;
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="section-title" style={{ margin: 0 }}>
          Infrastructure
        </div>
        <span className="grow" />
        <Button small variant="ghost" onClick={() => useOffice.getState().openPanel('hosts')}>
          Open the server room
        </Button>
      </div>
      <div className="grid3" style={{ gap: 8 }}>
        <Stat label="Machines online" value={online} tone={online ? 'good' : undefined} />
        <Stat label="Machines offline" value={offline} tone={offline ? 'bad' : undefined} />
        <Stat label="Sessions running" value={running} />
      </div>
      {unobservable > 0 && (
        <div className="pc-note" style={{ marginTop: 8 }}>
          {unobservable} session{unobservable === 1 ? '' : 's'} cannot be observed while {unobservable === 1 ? 'its' : 'their'} machine is offline.
        </div>
      )}
      {hosts.length === 0 && (
        <div className="small muted" style={{ marginTop: 8 }}>
          No machine is connected yet.
        </div>
      )}
    </div>
  );
}

function Usage() {
  const sessions = useOffice((s) => s.sessions);
  const all = Object.values(sessions);
  const measured = all.filter((s) => s.usage !== null);
  const sum = measured.reduce(
    (acc, s) => ({
      input: acc.input + s.usage!.inputTokens,
      output: acc.output + s.usage!.outputTokens,
      cacheRead: acc.cacheRead + s.usage!.cacheReadTokens,
      cacheWrite: acc.cacheWrite + s.usage!.cacheCreationTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const has = measured.length > 0;
  // Only SDK-managed workers come with a cost figure, and it is the SDK's own estimate.
  const costed = measured.filter((s) => typeof s.usage!.costUsdEstimate === 'number');
  const cost = costed.reduce((acc, s) => acc + (s.usage!.costUsdEstimate ?? 0), 0);
  const value = (n: number) => (has ? fmtInt(n) : <span className="muted">{NOT_AVAILABLE}</span>);
  return (
    <div>
      <div className="row" style={{ margin: '14px 0 6px' }}>
        <div className="section-title" style={{ margin: 0 }}>
          Token usage
        </div>
        {has && <Provenance kind="measured" />}
      </div>
      <div className="card col" style={{ gap: 8 }}>
        <dl className="kv">
          <dt>Input tokens</dt>
          <dd className="mono">{value(sum.input)}</dd>
          <dt>Output tokens</dt>
          <dd className="mono">{value(sum.output)}</dd>
          <dt>Cache-read tokens</dt>
          <dd className="mono">{value(sum.cacheRead)}</dd>
          <dt>Cache-write tokens</dt>
          <dd className="mono">{value(sum.cacheWrite)}</dd>
          <dt>Cost</dt>
          <dd>
            {costed.length ? (
              <span className="mono" title="Reported by the Claude Agent SDK for SDK-managed workers, since each worker process started. The SDK describes it as an estimate, not a bill.">
                ≈ ${cost.toFixed(4)} <span className="faint">(SDK estimate, {costed.length} SDK-managed session{costed.length === 1 ? '' : 's'})</span>
              </span>
            ) : (
              <span className="muted">{NOT_AVAILABLE}</span>
            )}
          </dd>
        </dl>
        <div className="small faint">
          {has
            ? `Measured from the Claude Code transcripts on the machines, summed over ${measured.length} of ${all.length} recorded session${all.length === 1 ? '' : 's'}${
                all.length - measured.length > 0 ? `; for the other ${all.length - measured.length} usage is not available, so the real total may be higher` : ''
              }.`
            : `Usage is measured from Claude Code transcripts on the machines. ${all.length ? `None of the ${all.length} recorded session${all.length === 1 ? ' has' : 's have'} a measurement` : 'There are no sessions yet'}, so no totals are shown.`}{' '}
          {costed.length
            ? 'The cost figure is the Claude Agent SDK’s own running estimate for SDK-managed workers only; interactive Claude Code sessions expose no cost, so it is not a total.'
            : 'Cost is not available because interactive Claude Code does not expose it; nothing here is estimated.'}
        </div>
      </div>
    </div>
  );
}

function Timeline({ onClose }: { onClose: () => void }) {
  const events = useOffice((s) => s.events);
  const shown = useMemo(() => events.filter(isLoudEvent).slice(-40).reverse(), [events]);
  const go = (e: OrchestratorEvent) => {
    const st = useOffice.getState();
    if (e.taskId && st.tasks[e.taskId]) st.openPanel('task', e.taskId);
    else if (e.employeeId && st.employees[e.employeeId]) {
      st.focusEmployee(e.employeeId);
      onClose();
    }
  };
  return (
    <div>
      <div className="section-title">Activity timeline</div>
      <div className="card pc-timeline" style={{ padding: '6px 0' }}>
        {shown.length === 0 && <div className="feed-item muted">Nothing has happened yet.</div>}
        {shown.map((e) => (
          <button key={e.id} className="feed-item" onClick={() => go(e)} title={`${e.summary}\n${e.type} · source: ${e.source.kind} · ${new Date(e.ts).toLocaleString()}`}>
            <span className="feed-time">{clock(e.ts)}</span>
            <span className={`feed-text ${eventTone(e)}`}>{e.summary}</span>
          </button>
        ))}
      </div>
      {shown.length > 0 && (
        <div className="small faint" style={{ marginTop: 4 }}>
          The last {shown.length} recorded event{shown.length === 1 ? '' : 's'}, newest first. Each comes from a hook, an agent's tool call, a machine observation or your own action.
        </div>
      )}
    </div>
  );
}

function LimitRow({ label, w }: { label: string; w: { usedPercent: number; resetsAt: string | null } | null }) {
  const text = limitText(w);
  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="small muted" style={{ width: 62, flex: 'none' }}>
        {label}
      </span>
      {w ? <Progress value={w.usedPercent} tone={w.usedPercent >= 90 ? 'bad' : w.usedPercent >= 70 ? 'warn' : 'good'} /> : <span className="grow" />}
      <span className="small mono pc-nowrap" title={w?.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : undefined}>
        {text ?? <span className="muted">{NOT_AVAILABLE}</span>}
      </span>
    </div>
  );
}

/** How much Claude is left: one card per account the employees run on. */
function ClaudeAccounts() {
  const accounts = useOffice((s) => s.accounts);
  const employees = useOffice((s) => s.employees);
  const hosts = useOffice((s) => s.hosts);
  useEffect(() => {
    void loadAccounts();
  }, []);
  return (
    <div>
      <div className="row" style={{ margin: '14px 0 6px' }}>
        <div className="section-title" style={{ margin: 0 }}>
          Claude left
        </div>
      </div>
      {accounts.length === 0 && <div className="card small muted">No employee is placed on a machine yet, so there is no Claude account to show.</div>}
      <div className="col" style={{ gap: 8 }}>
        {accounts.map((a) => {
          const who = a.employeeIds.map((id) => employees[id]?.name).filter(Boolean);
          return (
            <div key={a.key} className="card col claude-account" style={{ gap: 6 }}>
              <div className="row">
                <span className="strong grow truncate">{accountName(a, hosts[a.hostId]?.name)}</span>
                {a.organization && <span className="small faint truncate">{a.organization}</span>}
              </div>
              {a.reportedAt ? (
                <>
                  <LimitRow label="5 hours" w={a.fiveHour} />
                  <LimitRow label="This week" w={a.sevenDay} />
                </>
              ) : (
                <div className="small muted">Not reported yet. Claude Code says how much is used when a session on this account starts; it will appear here the next time one of these employees starts a session. A session that was already running before this was added reports after it is stopped and resumed.</div>
              )}
              <div className="small faint">
                {hosts[a.hostId]?.name ?? 'unknown machine'} · {a.configDir ?? 'default login'} · used by {who.length ? who.join(', ') : 'nobody'}
                {a.reportedAt ? ` · reported ${timeAgo(a.reportedAt)}${a.reportedBy && employees[a.reportedBy] ? ` by ${employees[a.reportedBy]!.name}'s session` : ''}` : ''}
              </div>
            </div>
          );
        })}
      </div>
      <div className="small faint" style={{ marginTop: 4 }}>
        These are the percentages Claude Code itself shows for a subscription account, passed on by each session's status line; nothing is estimated. An account billed by API key has no such limits and reports nothing. To put an employee on another account, set their Claude account folder in their profile.
      </div>
    </div>
  );
}

function CeoPanel({ onClose }: PanelProps) {
  const settings = useOffice((s) => s.settings);
  const [away, setAway] = useState<CommandResult | null>(null);
  const [busy, setBusy] = useState(false);
  const summarize = async () => {
    setBusy(true);
    const res = await act(() => api<CommandResult>('POST', '/commands/execute', { input: 'summarize what happened while I was away' }));
    setBusy(false);
    if (res) setAway(res);
  };
  return (
    <Window
      title="CEO desk"
      subtitle={[settings?.companyName, settings?.ownerName].filter(Boolean).join(' · ') || undefined}
      onClose={onClose}
      width={1180}
      actions={
        <Button small variant="primary" onClick={summarize} disabled={busy}>
          {busy ? 'Summarising…' : 'What happened while I was away'}
        </Button>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {away && (
          <div className="card col" style={{ gap: 6 }}>
            <div className="row">
              <span className="strong grow">{away.answer?.title ?? 'While you were away'}</span>
              <Button small variant="ghost" onClick={() => setAway(null)}>
                Close summary
              </Button>
            </div>
            {away.answer ? (
              away.answer.lines.length ? (
                away.answer.lines.map((l, i) => (
                  <div key={i} className="small pre">
                    {l}
                  </div>
                ))
              ) : (
                <div className="small muted">Nothing was recorded.</div>
              )
            ) : (
              <>
                {away.executed.map((x, i) => (
                  <div key={i} className="small">
                    <Badge tone={x.ok ? 'good' : 'bad'}>{x.ok ? 'done' : 'failed'}</Badge> {x.description} <span className="muted">— {x.detail}</span>
                  </div>
                ))}
                {away.executed.length === 0 && <div className="small muted">The server returned no summary.</div>}
              </>
            )}
          </div>
        )}
        <Warnings onClose={onClose} />
        <div className="pc-cols">
          <div className="col" style={{ gap: 0 }}>
            <div className="section-title">Project portfolio</div>
            <Portfolio />
            <div style={{ height: 14 }} />
            <Timeline onClose={onClose} />
          </div>
          <div className="col" style={{ gap: 0 }}>
            <div className="section-title">Pending decisions</div>
            <Decisions />
            <div style={{ height: 14 }} />
            <Infrastructure />
            <ClaudeAccounts />
            <Usage />
          </div>
        </div>
      </div>
    </Window>
  );
}
registerPanel('ceo', CeoPanel);
