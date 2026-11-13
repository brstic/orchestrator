import { useEffect, useMemo, useState } from 'react';
import type { Notification, Question, QuestionStatus } from '@orchestrator/contracts';
import { Avatar, Button, Tabs, Window, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { approvalLine, byDay, deliveryWord, needLine, oneLine } from '../../lib/inbox.ts';
import { useOffice } from '../../lib/store.ts';
import { needsYou } from '../../lib/attention.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { More, State } from './kit.tsx';
import { fmtDateTime, humanize, openNotificationTarget, type PanelProps } from './company-shared.tsx';

/**
 * The Inbox (docs/UI.md is the look): what needs me, what the office told me, and what became of my answers — each
 * a list of single lines in a window that keeps its size, however much there is. A click on a line goes to the
 * thing itself; nothing is answered here.
 */

type TabId = 'needs' | 'all' | 'answered';

const STATUS_TIP: Record<QuestionStatus, string> = {
  open: 'Waiting for you',
  answered: 'You replied; delivery to the session is in flight',
  delivered: 'Handed to the runtime (hook output written, tool result returned or keys sent) — not yet acknowledged',
  confirmed: 'The runtime acknowledged it: the answer really arrived',
  failed: 'The answer could not be delivered',
  superseded: 'Resolved elsewhere (for example answered directly in the terminal) or timed out',
};

/** How many lines of news stand in the window before "show more". */
const NEWS_STEP = 40;

/** A piece of news: one line. A dot only when it is a warning; bold while it is new; a click goes to what it is about. */
function News({ n, onClose }: { n: Notification; onClose: () => void }) {
  const tone = n.severity === 'critical' ? 'bad' : n.severity === 'warning' ? 'busy' : null;
  const body = oneLine(n.body, 120);
  return (
    <div className={`k-row k-row-sm k-row-click ${n.resolvedAt ? 'k-dim' : ''}`} role="button" tabIndex={0} onClick={() => openNotificationTarget(n) && onClose()} onKeyDown={(ev) => ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ') && openNotificationTarget(n) && onClose()} data-news={n.id} title={n.body || undefined}>
      <span className={`k-dot ${tone ? `k-dot-${tone}` : 'k-dot-off'}`} title={n.severity} aria-hidden />
      <span className="k-main">
        <span className="k-title k-title-sm" style={n.readAt ? undefined : { fontWeight: 650 }}>
          {n.title}
          {body && <span className="k-title-note">{body}</span>}
        </span>
      </span>
      <span className="k-aside" title={fmtDateTime(n.createdAt)}>
        {humanize(n.kind)} · {timeAgo(n.createdAt)}
      </span>
      {!n.resolvedAt && (
        <button
          type="button"
          className="k-x"
          onClick={(ev) => {
            ev.stopPropagation();
            void act(() => api('POST', `/notifications/${n.id}/resolve`, {}));
          }}
          title="Dismiss: it is dealt with"
          aria-label={`Dismiss: ${n.title}`}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** Somebody asks, or asks to be allowed: who, what in one line, for how long — and a click opens it to be answered. */
function Asking({ q }: { q: Question }) {
  const e = useOffice((s) => (q.employeeId ? s.employees[q.employeeId] : undefined));
  const task = useOffice((s) => (q.taskId ? s.tasks[q.taskId] : undefined));
  const approval = q.kind === 'permission';
  return (
    <button type="button" className="k-row" onClick={() => useOffice.getState().openPanel('question', q.id)} data-asking={q.id} title={q.text}>
      {e ? <Avatar appearance={e.appearance} size={32} /> : <span className="k-dot k-dot-busy" aria-hidden />}
      <span className="k-main">
        <span className="k-title">
          {e ? e.name : 'The office'}
          <span className="k-title-note">
            {approval ? 'asks to be allowed' : 'asks'}
            {task ? ` · ${task.key}` : ''}
          </span>
        </span>
        <span className={`k-sub ${approval ? 'k-mono' : ''}`}>{approval ? approvalLine(q.tool, q.text) : oneLine(q.text)}</span>
      </span>
      <span className="k-aside" title={`${fmtDateTime(q.createdAt)} · via ${humanize(q.channel)}`}>
        {timeAgo(q.createdAt)}
      </span>
      <State word={approval ? 'Decide' : 'Answer'} tone="warn" />
    </button>
  );
}

function NotificationsPanel({ arg, onClose }: PanelProps) {
  const questionsById = useOffice((s) => s.questions);
  const notificationsById = useOffice((s) => s.notifications);
  const employees = useOffice((s) => s.employees);
  // `openPanel('notifications', 'all' | 'answered')` opens that tab.
  const [tab, setTab] = useState<TabId>(arg === 'all' || arg === 'answered' ? arg : 'needs');
  const [newsShown, setNewsShown] = useState(NEWS_STEP);

  // Opening the inbox counts as reading it — but only once it has actually been looked at.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const unread = Object.values(useOffice.getState().notifications).some((n) => !n.readAt);
      if (unread) void api('POST', '/notifications/read', { ids: 'all' }).catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(t);
  }, []);

  const questions = useMemo(() => Object.values(questionsById), [questionsById]);
  const notifications = useMemo(() => Object.values(notificationsById).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), [notificationsById]);
  const { questions: open, stuck, count: needCount } = useMemo(() => needsYou(questionsById, notificationsById), [questionsById, notificationsById]);
  // Whoever asks to be allowed something stands still until told: those first, then the questions.
  const approvals = open.filter((q) => q.kind === 'permission');
  const asked = open.filter((q) => q.kind !== 'permission');
  const answered = questions
    .filter((q) => q.status !== 'open')
    .sort((a, b) => ((a.answeredAt ?? a.createdAt) < (b.answeredAt ?? b.createdAt) ? 1 : -1))
    .slice(0, 60);
  const live = notifications.filter((n) => !n.resolvedAt);
  const dismissed = notifications.filter((n) => !!n.resolvedAt);
  const unread = notifications.filter((n) => !n.readAt).length;
  const kinds = [approvals.length > 0, asked.length > 0, stuck.length > 0].filter(Boolean).length;

  return (
    <Window kit title="Inbox" subtitle={needLine(needCount)} onClose={onClose} width={820} flush>
      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'needs', label: 'Needs you', count: needCount },
          { id: 'all', label: 'News', count: unread },
          { id: 'answered', label: 'Answered' },
        ]}
      />
      <div className="k-body" data-inbox={tab}>
        {tab === 'needs' && (
          <div className="k-stack">
            {needCount === 0 && (
              <div className="k-empty">
                <div className="k-title">Nothing needs you</div>
                <div className="k-text">When an employee asks you something, asks to be allowed something, or is stuck until you act, it stands here — and on the Inbox button at the top of the office.</div>
              </div>
            )}
            {approvals.length > 0 && (
              <section className="k-section">
                {kinds > 1 && <div className="k-label">To be allowed · {approvals.length}</div>}
                <div className="k-group k-notice">
                  {approvals.map((q) => (
                    <Asking key={q.id} q={q} />
                  ))}
                </div>
              </section>
            )}
            {asked.length > 0 && (
              <section className="k-section">
                {kinds > 1 && <div className="k-label">Questions · {asked.length}</div>}
                <div className="k-group k-notice">
                  {asked.map((q) => (
                    <Asking key={q.id} q={q} />
                  ))}
                </div>
              </section>
            )}
            {stuck.length > 0 && (
              <section className="k-section">
                <div className="k-label">Stuck until you act · {stuck.length}</div>
                <div className="k-group">
                  {stuck.map((n) => (
                    <News key={n.id} n={n} onClose={onClose} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {tab === 'all' && (
          <div className="k-stack">
            {notifications.length === 0 ? (
              <div className="k-empty">
                <div className="k-title">No news yet</div>
                <div className="k-text">What happens in the office and is worth knowing — a task finished, somebody blocked, a machine gone — is listed here, newest first.</div>
              </div>
            ) : (
              <>
                <div className="k-head">
                  <div className="k-sub">
                    {unread > 0 ? `${unread} new · ` : ''}
                    {live.length} to look at{dismissed.length ? ` · ${dismissed.length} dismissed` : ''}
                  </div>
                  <Button small variant="ghost" className="k-quiet" disabled={unread === 0} onClick={() => act(() => api('POST', '/notifications/read', { ids: 'all' }), 'All notifications marked read')}>
                    Mark all read
                  </Button>
                </div>
                {live.length === 0 && <div className="k-sub">Everything has been dismissed.</div>}
                {byDay(live.slice(0, newsShown)).map((g) => (
                  <section key={g.day} className="k-section">
                    <div className="k-label">{g.day}</div>
                    <div className="k-group">
                      {g.rows.map((n) => (
                        <News key={n.id} n={n} onClose={onClose} />
                      ))}
                    </div>
                  </section>
                ))}
                {live.length > newsShown && (
                  <button type="button" className="k-link" style={{ alignSelf: 'flex-start' }} onClick={() => setNewsShown((n) => n + NEWS_STEP)}>
                    Show {Math.min(NEWS_STEP, live.length - newsShown)} more
                  </button>
                )}
                {dismissed.length > 0 && (
                  <More summary={`${dismissed.length} dismissed`}>
                    <div className="k-group">
                      {dismissed.slice(0, NEWS_STEP).map((n) => (
                        <News key={n.id} n={n} onClose={onClose} />
                      ))}
                    </div>
                  </More>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'answered' && (
          <div className="k-stack">
            {answered.length === 0 ? (
              <div className="k-empty">
                <div className="k-title">Nothing answered yet</div>
                <div className="k-text">What you answered and decided is kept here, each with whether your answer reached the employee.</div>
              </div>
            ) : (
              <>
                <div className="k-text">Your answers, newest first. The word at the end says whether the answer reached the employee; point at it for how.</div>
                <div className="k-group">
                  {answered.map((q) => {
                    const e = q.employeeId ? employees[q.employeeId] : undefined;
                    const reply = q.kind === 'permission' ? (q.decision ? `${q.decision === 'allow' ? 'Allowed' : 'Denied'}${q.answer ? ` — ${q.answer}` : ''}` : null) : (q.answer ?? (q.answers ? Object.values(q.answers).join(' · ') : null));
                    const fared = deliveryWord(q.status);
                    return (
                      <button key={q.id} type="button" className="k-row" onClick={() => useOffice.getState().openPanel('question', q.id)} data-answered={q.id} title={q.text}>
                        {e ? <Avatar appearance={e.appearance} size={32} /> : <span className="k-dot k-dot-off" aria-hidden />}
                        <span className="k-main">
                          <span className="k-title k-title-sm">
                            {e?.name ?? 'The office'}
                            <span className="k-title-note">{q.kind === 'permission' ? approvalLine(q.tool, q.text) : oneLine(q.text, 90)}</span>
                          </span>
                          <span className="k-sub">{reply ? `You: ${oneLine(reply, 120)}` : 'No reply from you was recorded.'}</span>
                        </span>
                        <span className="k-aside">{timeAgo(q.confirmedAt ?? q.deliveredAt ?? q.answeredAt ?? q.createdAt)}</span>
                        <State word={fared.word} tone={fared.tone} title={q.deliveryDetail ?? STATUS_TIP[q.status]} width={112} />
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Window>
  );
}
registerPanel('notifications', NotificationsPanel);
