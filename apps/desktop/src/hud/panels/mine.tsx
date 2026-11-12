import { useMemo, useState } from 'react';
import type { Employee, Host, Task } from '@orchestrator/contracts';
import { LEAD_HIRE_LIMIT } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Window, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { act } from '../core.tsx';
import { activityOf, currentTaskOf, openQuestionsOf, sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { NEEDS_KINDS } from '../../lib/attention.ts';
import { madeByMe, taskIsMine, whoseEmployee, whoseHost, whoseProject, whoseTask } from '../../lib/mine.ts';
import { WhoseBadge } from '../mine.tsx';
import { ActivityBadge, isLive } from './company-shared.tsx';
import { registerPanel } from './index.tsx';

/** The states a task is in while there is still something to do about it, in the order one wants to hear of them. */
const OPEN_ORDER: Task['status'][] = ['BLOCKED', 'REVIEW', 'IN_PROGRESS', 'READY', 'BACKLOG'];
const STATUS_WORD: Partial<Record<Task['status'], string>> = { BLOCKED: 'blocked', REVIEW: 'in review', IN_PROGRESS: 'in progress', READY: 'ready', BACKLOG: 'backlog' };
const STATUS_TONE: Partial<Record<Task['status'], 'bad' | 'warn' | 'info' | 'muted'>> = { BLOCKED: 'bad', REVIEW: 'warn', IN_PROGRESS: 'info', READY: 'muted', BACKLOG: 'muted' };

/**
 * The member's team lead: the one they tell what they want, who hands it to the right one of their employees. Shown
 * with what it may reach and how many people it has hired; where there is none yet, the way to get one.
 */
function LeadCard({ lead, machines, hired }: { lead: Employee | undefined; machines: Host[]; hired: number }) {
  const s = useOffice();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // A lead sits on a machine that is here now: this computer first, else a server of mine.
  const home = machines.find((h) => h.status === 'online' && !h.ownerId) ?? machines.find((h) => h.status === 'online');
  const hire = async () => {
    if (!home) return;
    setBusy(true);
    await act(async () => {
      // Where its session runs: the first folder that machine lets the office into. It is not a project.
      const listing = await api<{ path: string }>('GET', `/hosts/${home.id}/browse`);
      const made = await api<Employee>('POST', '/employees', { name: name.trim() || `${s.me?.name ?? 'My'} Lead`, roleKey: 'lead', hostId: home.id, workingDir: listing.path });
      s.openPanel('talk', made.id);
    }, 'Your team lead is hired. Tell them what you want.');
    setBusy(false);
  };
  if (!lead) {
    return (
      <div className="card col" style={{ gap: 8 }} data-lead="none">
        <div>
          <span className="strong">No team lead yet.</span>{' '}
          <span className="small muted">
            A lead is one more employee in your room. You tell them what you want — "look at the tickets for this project", "check that domain" — and they hand it to the one of your employees whose it is, ask you when that is not clear, and
            may hire up to {LEAD_HIRE_LIMIT} people onto your machines when nobody fits. They run on the lightest model and only when you speak to them.
          </span>
        </div>
        <div className="row row-wrap">
          <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder={`${s.me?.name ?? 'My'} Lead`} aria-label="Name of your team lead" style={{ width: 200 }} maxLength={40} />
          <Button small variant="primary" disabled={busy || !home} onClick={hire} title={home ? `On ${home.name}` : 'None of your machines is in the office right now'}>
            Hire a team lead
          </Button>
          {!home && <span className="small muted">None of your machines is in the office right now.</span>}
        </div>
      </div>
    );
  }
  const session = sessionOfEmployee(s.sessions, lead.id);
  const wide = lead.leadScope === 'office';
  return (
    <div className="card col" style={{ gap: 8 }} data-lead={lead.id}>
      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
        <Avatar appearance={lead.appearance} size={36} offline={!isLive(session)} />
        <div className="grow col" style={{ gap: 0, minWidth: 0 }}>
          <span className="strong truncate">
            {lead.name} <Badge tone="accent">your team lead</Badge>
          </span>
          <span className="small muted">
            Tell them what you want; they hand it to whose it is. Hired {hired} of {LEAD_HIRE_LIMIT} · {lead.model ?? 'default model'}
          </span>
        </div>
        <ActivityBadge activity={activityOf(session)} needsYou={openQuestionsOf(s.questions, lead.id).length > 0} />
        <Button small variant="primary" onClick={() => s.openPanel('talk', lead.id)}>
          Talk
        </Button>
        <Button small onClick={() => s.openPanel('employee', lead.id)}>
          Profile
        </Button>
      </div>
      <label className="check small" title="Your own employees are always theirs to direct. With this, the office's shared employees too — on the shared projects, as you may yourself.">
        <input type="checkbox" checked={wide} disabled={busy} onChange={(ev) => act(() => api('PATCH', `/employees/${lead.id}`, { leadScope: ev.target.checked ? 'office' : 'own' }), ev.target.checked ? `${lead.name} now directs the shared employees too` : `${lead.name} now directs your own employees only`)} />{' '}
        Also direct the office's shared employees
      </label>
    </div>
  );
}

/**
 * One's own part of a shared office, in one window: what waits for me, my employees, my tasks, my projects and my
 * machines. Everything here is also in the office's own lists (Team, Tasks, Projects — "Everyone"); this is where
 * someone who has just come in starts.
 */
function MinePanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const s = useOffice();
  const me = s.me;
  const open = s.openPanel;

  const all = useMemo(() => Object.values(s.employees).filter((e) => !e.archived && whoseEmployee(s.hosts, me, e).kind === 'mine').sort((a, b) => a.name.localeCompare(b.name)), [s.employees, s.hosts, me]);
  // The lead is shown on its own, above the people it directs.
  const lead = all.find((e) => e.roleKey === 'lead');
  const employees = useMemo(() => all.filter((e) => e.roleKey !== 'lead'), [all]);
  const mineIds = useMemo(() => new Set(employees.map((e) => e.id)), [employees]);
  const projects = useMemo(() => Object.values(s.projects).filter((p) => p.status !== 'archived' && whoseProject(s.hosts, me, p).kind === 'mine').sort((a, b) => a.name.localeCompare(b.name)), [s.projects, s.hosts, me]);
  const machines = useMemo(() => Object.values(s.hosts).filter((h) => h.status !== 'revoked' && whoseHost(s.hosts, me, h.id).kind === 'mine').sort((a, b) => Number(!!a.ownerId) - Number(!!b.ownerId) || a.name.localeCompare(b.name)), [s.hosts, me]);
  const tasks = useMemo(
    () =>
      Object.values(s.tasks)
        .filter((t) => t.kind !== 'review' && OPEN_ORDER.includes(t.status) && taskIsMine(s.hosts, me, t, s.projects, s.employees))
        .sort((a, b) => OPEN_ORDER.indexOf(a.status) - OPEN_ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)),
    [s.tasks, s.hosts, s.projects, s.employees, me],
  );
  // What waits for me: my employees' questions and approvals, and whatever is stuck around them or my machines.
  const questions = useMemo(() => Object.values(s.questions).filter((q) => q.status === 'open' && !!q.employeeId && mineIds.has(q.employeeId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [s.questions, mineIds]);
  const stuck = useMemo(
    () =>
      Object.values(s.notifications)
        .filter((n) => !n.resolvedAt && NEEDS_KINDS.has(n.kind) && ((n.employeeId && mineIds.has(n.employeeId)) || (n.hostId && machines.some((h) => h.id === n.hostId))))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [s.notifications, mineIds, machines],
  );
  const working = employees.filter((e) => !['offline', 'unknown', 'idle', 'waiting_input', 'paused'].includes(activityOf(sessionOfEmployee(s.sessions, e.id)))).length;
  const waiting = questions.length + stuck.length;

  const row = (e: Employee) => {
    const session = sessionOfEmployee(s.sessions, e.id);
    const task = currentTaskOf(s.tasks, e.id);
    const project = e.projectId ? s.projects[e.projectId] : undefined;
    return (
      <div key={e.id} className="list-item mine-row" data-mine-employee={e.id}>
        <Avatar appearance={e.appearance} size={32} offline={!isLive(session)} />
        <div className="grow col" style={{ gap: 0, minWidth: 0 }}>
          <span className="strong truncate">
            {e.name} <span className="small muted">· {e.title}</span>
          </span>
          <span className="small muted truncate">
            {project ? project.name : 'no project'} · {s.hosts[e.hostId ?? '']?.name ?? 'no machine'}
            {task ? ` · ${task.key} ${task.title}` : ''}
          </span>
        </div>
        <ActivityBadge activity={activityOf(session)} needsYou={openQuestionsOf(s.questions, e.id).length > 0} />
        <Button small variant="primary" onClick={() => open('talk', e.id)}>
          Talk
        </Button>
        <Button small onClick={() => s.enterWorkstation(e.id)} disabled={!session} title={session ? 'Sit at their real terminal' : 'No session yet'}>
          Terminal
        </Button>
        <Button small onClick={() => open('employee', e.id)}>
          Profile
        </Button>
      </div>
    );
  };

  return (
    <Window
      title="My work"
      subtitle={`${me?.name ?? 'You'} · ${employees.length} employee${employees.length === 1 ? '' : 's'}, ${working} working · ${tasks.length} open task${tasks.length === 1 ? '' : 's'}${waiting ? ` · ${waiting} waiting for you` : ''}`}
      onClose={onClose}
      width={1040}
      actions={
        <>
          <Button small onClick={() => open('myroom')} title="Your computer in the office, your room and your servers">
            My room
          </Button>
          <Button small variant="primary" onClick={() => open('team', 'hire')}>
            Hire
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 18 }} data-mine>
        <section>
          <div className="section-title" style={{ marginTop: 0 }}>
            Waiting for you {waiting > 0 && <Badge tone="warn">{waiting}</Badge>}
          </div>
          {waiting === 0 ? (
            <div className="small muted">Nothing of yours is waiting for an answer or stuck.</div>
          ) : (
            <div className="list">
              {questions.map((q) => (
                <button key={q.id} type="button" className="list-item pw-list-btn" onClick={() => open('question', q.id)}>
                  <Badge tone="warn">{q.kind === 'permission' ? 'approval' : 'question'}</Badge>
                  <span className="grow truncate">
                    <span className="strong">{s.employees[q.employeeId ?? '']?.name ?? 'An employee'}</span> {q.kind === 'permission' ? 'asks to be allowed something' : 'asks you something'}
                  </span>
                  <span className="small faint">{timeAgo(q.createdAt)}</span>
                </button>
              ))}
              {stuck.map((n) => (
                <button key={n.id} type="button" className="list-item pw-list-btn" onClick={() => (n.taskId && s.tasks[n.taskId] ? open('task', n.taskId) : n.employeeId && s.employees[n.employeeId] ? open('employee', n.employeeId) : open('notifications'))}>
                  <Badge tone={n.severity === 'critical' ? 'bad' : 'warn'}>{n.kind.replace(/_/g, ' ')}</Badge>
                  <span className="grow truncate">{n.title}</span>
                  <span className="small faint">{timeAgo(n.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="section-title">My team lead</div>
          <LeadCard lead={lead} machines={machines} hired={Object.values(s.employees).filter((e) => !e.archived && !!lead && e.hiredBy === lead.id).length} />
        </section>

        <section>
          <div className="section-title">My employees</div>
          {employees.length === 0 ? (
            <Empty title="Nobody works for you alone yet">
              Hire someone onto your own computer or server and they sit in your room. The office's shared employees are in <b>Team → Everyone</b>.
            </Empty>
          ) : (
            <div className="list">{employees.map(row)}</div>
          )}
        </section>

        <section>
          <div className="section-title">
            My open tasks{' '}
            <button type="button" className="pw-chip" onClick={() => open('tasks')}>
              the board
            </button>
          </div>
          {tasks.length === 0 ? (
            <div className="small muted">No open task on your machines, with your employees, or made by you.</div>
          ) : (
            <div className="list">
              {tasks.slice(0, 40).map((t) => {
                const whose = whoseTask(s.hosts, me, t, s.projects, s.employees);
                return (
                  <button key={t.id} type="button" className="list-item pw-list-btn" onClick={() => open('task', t.id)} data-mine-task={t.id}>
                    <Badge tone={STATUS_TONE[t.status] ?? 'muted'}>{STATUS_WORD[t.status] ?? t.status}</Badge>
                    <span className="mono small">{t.key}</span>
                    <span className="grow truncate">{t.title}</span>
                    <span className="small muted truncate" style={{ maxWidth: 220 }}>
                      {s.projects[t.projectId]?.name ?? ''}
                      {t.assigneeId && s.employees[t.assigneeId] ? ` · ${s.employees[t.assigneeId]!.name}` : ' · unassigned'}
                    </span>
                    {whose.kind !== 'mine' && <WhoseBadge whose={whose} />}
                    {whose.kind !== 'mine' && madeByMe(me, t) && <span className="small faint">made by you</span>}
                  </button>
                );
              })}
              {tasks.length > 40 && <div className="small muted">…and {tasks.length - 40} more on the board.</div>}
            </div>
          )}
        </section>

        <section className="grid2">
          <div>
            <div className="section-title">My projects</div>
            {projects.length === 0 ? (
              <div className="small muted">No project lives on your machines.</div>
            ) : (
              <div className="list">
                {projects.map((p) => {
                  const of = Object.values(s.tasks).filter((t) => t.projectId === p.id && t.kind !== 'review');
                  return (
                    <button key={p.id} type="button" className="list-item pw-list-btn" onClick={() => open('projects', p.id)}>
                      <span className="dot" style={{ background: p.color }} />
                      <span className="grow strong truncate">{p.name}</span>
                      <span className="small muted">
                        {of.filter((t) => t.status === 'DONE').length}/{of.length} done
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <div className="section-title">My machines</div>
            <div className="list">
              {machines.map((h) => (
                <button key={h.id} type="button" className="list-item pw-list-btn" onClick={() => open('myroom')}>
                  <span className={`dot ${h.status === 'online' ? 'dot-good' : ''}`} />
                  <span className="grow strong truncate">{h.name}</span>
                  <span className="small muted">
                    {h.ownerId ? 'server' : 'computer'} · {h.status === 'online' ? 'in the office' : 'not here now'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </Window>
  );
}

registerPanel('mine', MinePanel);
