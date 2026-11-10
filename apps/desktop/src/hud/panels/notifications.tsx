import { useEffect, useMemo, useState } from 'react';
import type { Notification, NotificationKind, Question, QuestionStatus } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Markdown, Tabs, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { fmtDateTime, humanize, openNotificationTarget, severityDot, type PanelProps } from './company-shared.tsx';

type TabId = 'needs' | 'all' | 'answered';

/** Notification kinds that mean someone is stuck until the owner acts. */
const NEEDS_KINDS = new Set<NotificationKind>(['blocked', 'review', 'merge_conflict', 'session_lost', 'host_disconnected', 'host_resources', 'security']);

const STATUS_TONE: Record<QuestionStatus, Tone> = { open: 'warn', answered: 'info', delivered: 'info', confirmed: 'good', failed: 'bad', superseded: 'muted' };
const STATUS_TIP: Record<QuestionStatus, string> = {
  open: 'Waiting for you',
  answered: 'You replied; delivery to the session is in flight',
  delivered: 'Handed to the runtime (hook output written, tool result returned or keys sent) — not yet acknowledged',
  confirmed: 'The runtime acknowledged it: the answer really arrived',
  failed: 'The answer could not be delivered',
  superseded: 'Resolved elsewhere (for example answered directly in the terminal) or timed out',
};

function NotificationRow({ n, onClose }: { n: Notification; onClose: () => void }) {
  return (
    <div className={`row ${n.resolvedAt ? 'pc-dim' : ''}`} style={{ alignItems: 'flex-start', gap: 4 }}>
      <button className="pc-rowbtn grow" style={{ alignItems: 'flex-start' }} onClick={() => openNotificationTarget(n) && onClose()}>
        <span className={severityDot(n.severity)} style={{ marginTop: 6 }} title={n.severity} />
        <span className="grow col" style={{ gap: 2 }}>
          <span className="row" style={{ gap: 6 }}>
            <span className={`truncate ${n.readAt ? '' : 'strong'}`}>{n.title}</span>
            {!n.readAt && !n.resolvedAt && <Badge tone="accent">new</Badge>}
          </span>
          {n.body && <span className="small muted pre">{n.body}</span>}
          <span className="small faint">
            {humanize(n.kind)} · <span title={fmtDateTime(n.createdAt)}>{timeAgo(n.createdAt)}</span>
            {n.resolvedAt ? ` · resolved ${timeAgo(n.resolvedAt)}` : ''}
          </span>
        </span>
      </button>
      {!n.resolvedAt && (
        <Button small variant="ghost" onClick={() => act(() => api('POST', `/notifications/${n.id}/resolve`, {}))} title="Mark as dealt with">
          Dismiss
        </Button>
      )}
    </div>
  );
}

function QuestionCard({ q }: { q: Question }) {
  const employees = useOffice((s) => s.employees);
  const tasks = useOffice((s) => s.tasks);
  const e = q.employeeId ? employees[q.employeeId] : undefined;
  const task = q.taskId ? tasks[q.taskId] : undefined;
  const approval = q.kind === 'permission';
  const command = approval && q.tool && typeof (q.tool.input as { command?: unknown } | null)?.command === 'string' ? ((q.tool.input as { command: string }).command) : null;
  return (
    <div className="card row" style={{ alignItems: 'flex-start', gap: 12 }}>
      {e ? <Avatar appearance={e.appearance} size={34} /> : <span className="dot dot-warn" style={{ marginTop: 6 }} />}
      <div className="grow col" style={{ gap: 4 }}>
        <div className="row row-wrap" style={{ gap: 6 }}>
          <span className="strong">{e ? e.name : 'Orchestrator'}</span>
          {e && <span className="small muted">{e.title}</span>}
          <Badge tone="warn">{approval ? 'approval request' : humanize(q.kind)}</Badge>
          {task && <span className="small mono muted">{task.key}</span>}
          <span className="small faint" title={fmtDateTime(q.createdAt)}>
            {timeAgo(q.createdAt)} · via {humanize(q.channel)}
          </span>
        </div>
        <Markdown text={q.text} />
        {command && <div className="code">{command}</div>}
      </div>
      <Button variant="primary" small onClick={() => useOffice.getState().openPanel('question', q.id)}>
        {approval ? 'Review' : 'Answer'}
      </Button>
    </div>
  );
}

function NotificationsPanel({ arg, onClose }: PanelProps) {
  const questionsById = useOffice((s) => s.questions);
  const notificationsById = useOffice((s) => s.notifications);
  const employees = useOffice((s) => s.employees);
  // `openPanel('notifications', 'all' | 'answered')` opens that tab.
  const [tab, setTab] = useState<TabId>(arg === 'all' || arg === 'answered' ? arg : 'needs');

  // Opening the inbox counts as reading it — but only once it has actually been looked at.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const unread = Object.values(useOffice.getState().notifications).some((n) => !n.readAt);
      if (unread) void api('POST', '/notifications/read', { ids: 'all' }).catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(t);
  }, []);

  const questions = useMemo(() => Object.values(questionsById), [questionsById]);
  const notifications = useMemo(() => Object.values(notificationsById).sort((a, b) => Number(!!a.resolvedAt) - Number(!!b.resolvedAt) || (a.createdAt < b.createdAt ? 1 : -1)), [notificationsById]);
  const open = questions.filter((q) => q.status === 'open').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const answered = questions
    .filter((q) => q.status !== 'open')
    .sort((a, b) => ((a.answeredAt ?? a.createdAt) < (b.answeredAt ?? b.createdAt) ? 1 : -1))
    .slice(0, 60);
  const unresolved = notifications.filter((n) => !n.resolvedAt);
  const needs = unresolved.filter((n) => NEEDS_KINDS.has(n.kind));
  const unread = notifications.filter((n) => !n.readAt).length;

  return (
    <Window title="Inbox" subtitle={open.length ? `${open.length} waiting on you` : 'Nothing is waiting on you'} onClose={onClose} width={860} flush>
      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'needs', label: 'Needs you', count: open.length + needs.length },
          { id: 'all', label: 'All notifications', count: unresolved.length },
          { id: 'answered', label: 'Answered' },
        ]}
      />
      <div className="pc-tabbody">
        {tab === 'needs' && (
          <div className="col" style={{ gap: 10 }}>
            {open.length === 0 && needs.length === 0 && <Empty title="Nothing needs you">No open questions or approvals, and nobody is blocked on you.</Empty>}
            {open.map((q) => (
              <QuestionCard key={q.id} q={q} />
            ))}
            {needs.length > 0 && (
              <div>
                <div className="section-title">Also stuck</div>
                <div className="col" style={{ gap: 2 }}>
                  {needs.map((n) => (
                    <NotificationRow key={n.id} n={n} onClose={onClose} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'all' && (
          <div className="col" style={{ gap: 8 }}>
            <div className="row">
              <span className="small muted">
                {unresolved.length} unresolved · {unread} unread · {notifications.length} in total
              </span>
              <span className="grow" />
              <Button small disabled={unread === 0} onClick={() => act(() => api('POST', '/notifications/read', { ids: 'all' }), 'All notifications marked read')}>
                Mark all read
              </Button>
            </div>
            {notifications.length === 0 && <Empty title="No notifications">Events that deserve your attention appear here.</Empty>}
            <div className="col" style={{ gap: 2 }}>
              {notifications.map((n) => (
                <NotificationRow key={n.id} n={n} onClose={onClose} />
              ))}
            </div>
          </div>
        )}

        {tab === 'answered' && (
          <div className="col" style={{ gap: 8 }}>
            <div className="pc-info">
              Whether an answer really arrived: <b>answered</b> means you replied and delivery is in flight, <b>delivered</b> means it was handed to the runtime, and only <b>confirmed</b> means the runtime acknowledged it. <b>Failed</b> and <b>superseded</b> answers did
              not reach the session this way.
            </div>
            {answered.length === 0 && <Empty title="No answered questions yet">Questions you have answered are kept here with their delivery state.</Empty>}
            <div className="list">
              {answered.map((q) => {
                const e = q.employeeId ? employees[q.employeeId] : undefined;
                const reply = q.kind === 'permission' ? (q.decision ? `${q.decision === 'allow' ? 'Allowed' : 'Denied'}${q.answer ? ` — ${q.answer}` : ''}` : null) : (q.answer ?? (q.answers ? Object.values(q.answers).join(' · ') : null));
                return (
                  <button key={q.id} className="card card-click pc-cardbtn" onClick={() => useOffice.getState().openPanel('question', q.id)}>
                    <span className="row row-wrap" style={{ gap: 6 }}>
                      <span className="strong">{e?.name ?? 'Orchestrator'}</span>
                      <Badge tone="muted">{q.kind === 'permission' ? 'approval' : humanize(q.kind)}</Badge>
                      <span className="grow" />
                      <Badge tone={STATUS_TONE[q.status]} title={STATUS_TIP[q.status]}>
                        {q.status}
                      </Badge>
                      <span className="small faint">{timeAgo(q.confirmedAt ?? q.deliveredAt ?? q.answeredAt ?? q.createdAt)}</span>
                    </span>
                    <span className="truncate" style={{ display: 'block', marginTop: 4 }}>
                      {q.text}
                    </span>
                    <span className="small muted truncate" style={{ display: 'block' }}>
                      {reply ? `Your reply: ${reply}` : 'No reply from you was recorded.'}
                    </span>
                    <span className="small faint" style={{ display: 'block' }}>
                      {q.deliveryDetail ?? STATUS_TIP[q.status]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Window>
  );
}
registerPanel('notifications', NotificationsPanel);
