import { useMemo, useState } from 'react';
import type { Employee, Host } from '@orchestrator/contracts';
import { LEAD_HIRE_LIMIT } from '@orchestrator/contracts';
import { Avatar, Button, Window, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { act } from '../core.tsx';
import { activityOf, currentTaskOf, openQuestionsOf, sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { NEEDS_KINDS } from '../../lib/attention.ts';
import { madeByMe, taskIsMine, whoseEmployee, whoseHost, whoseProject, whoseTask } from '../../lib/mine.ts';
import { OPEN_ORDER, aboutEmployee, askLine, byAttention, employeeState, myWorkLine, projectLine, taskState, tasksByProject } from '../../lib/my-work.ts';
import { WhoseBadge } from '../mine.tsx';
import { isLive, isWorking, onActivate } from './company-shared.tsx';
import { registerPanel } from './index.tsx';
import { State } from './kit.tsx';

/** How many open tasks stand in the window; the board has the rest. */
const TASKS_SHOWN = 12;

/** Hiring a team lead, opened in place: what a lead is, a name for it, and the machine it goes onto. */
function LeadForm({ machines, onClose }: { machines: Host[]; onClose: () => void }) {
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
  return (
    <form
      className="k-sheet"
      data-lead-form
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!busy) void hire();
      }}
    >
      <div className="k-text">
        A team lead is one more employee of yours. You tell them what you want — "look at the tickets for this project", "check that domain" — and they hand it to the one of your employees whose it is, and ask you when that is not clear. When nobody
        fits they may hire, up to {LEAD_HIRE_LIMIT} people onto your machines. They run on the lightest model, and only when you speak to them.
      </div>
      {!home && <div className="k-note">None of your machines is in the office right now: a lead needs one to sit on.</div>}
      <div className="k-actions">
        <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder={`${s.me?.name ?? 'My'} Lead`} aria-label="Name of your team lead" style={{ width: 200 }} maxLength={40} autoFocus />
        {/* (Not blue: the window's one main button is Hire, above.) */}
        <Button small type="submit" disabled={busy || !home}>
          {busy ? 'Hiring…' : `Hire onto ${home?.name ?? 'your machine'}`}
        </Button>
        <Button small variant="ghost" type="button" className="k-quiet" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * One's own part of a shared office, in one window (docs/UI.md is the look). Two columns: my people on the left —
 * the team lead first, then whoever wants me, whoever works, whoever sleeps — and my open tasks on the right, by
 * project. What waits for me stands across the top, only when something does. Everything here is also in the
 * office's own lists (Team, Tasks, Projects — "Everyone"); this is where someone who has just come in starts.
 */
function MinePanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const s = useOffice();
  const me = s.me;
  const open = s.openPanel;
  /** The one person whose line is open (one at a time: the window does not grow down the screen). */
  const [openId, setOpenId] = useState<string | null>(null);
  const [hiringLead, setHiringLead] = useState(false);

  const all = useMemo(() => Object.values(s.employees).filter((e) => !e.archived && whoseEmployee(s.hosts, me, e).kind === 'mine'), [s.employees, s.hosts, me]);
  // The lead is shown first, above the people it directs, and is not counted among them.
  const lead = all.find((e) => e.roleKey === 'lead');
  const employees = useMemo(() => all.filter((e) => e.roleKey !== 'lead'), [all]);
  const mineIds = useMemo(() => new Set(employees.map((e) => e.id)), [employees]);
  const projects = useMemo(() => Object.values(s.projects).filter((p) => p.status !== 'archived' && whoseProject(s.hosts, me, p).kind === 'mine'), [s.projects, s.hosts, me]);
  const machines = useMemo(() => Object.values(s.hosts).filter((h) => h.status !== 'revoked' && whoseHost(s.hosts, me, h.id).kind === 'mine').sort((a, b) => Number(!!a.ownerId) - Number(!!b.ownerId) || a.name.localeCompare(b.name)), [s.hosts, me]);
  const tasks = useMemo(
    () =>
      Object.values(s.tasks)
        .filter((t) => t.kind !== 'review' && OPEN_ORDER.includes(t.status) && taskIsMine(s.hosts, me, t, s.projects, s.employees))
        .sort((a, b) => OPEN_ORDER.indexOf(a.status) - OPEN_ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)),
    [s.tasks, s.hosts, s.projects, s.employees, me],
  );
  const groups = useMemo(() => tasksByProject(tasks, projects, s.projects, TASKS_SHOWN), [tasks, projects, s.projects]);
  const unlisted = groups.reduce((n, g) => n + g.more, 0);
  // What waits for me: my employees' questions and approvals, and whatever is stuck around them or my machines.
  const questions = useMemo(() => Object.values(s.questions).filter((q) => q.status === 'open' && !!q.employeeId && mineIds.has(q.employeeId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [s.questions, mineIds]);
  const stuck = useMemo(
    () =>
      Object.values(s.notifications)
        .filter((n) => !n.resolvedAt && NEEDS_KINDS.has(n.kind) && ((n.employeeId && mineIds.has(n.employeeId)) || (n.hostId && machines.some((h) => h.id === n.hostId))))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [s.notifications, mineIds, machines],
  );
  const stateOf = (e: Employee) => employeeState(activityOf(sessionOfEmployee(s.sessions, e.id)), openQuestionsOf(s.questions, e.id).length > 0);
  const people = byAttention(employees.map((e) => ({ name: e.name, e, state: stateOf(e) })));
  const working = employees.filter((e) => isWorking(activityOf(sessionOfEmployee(s.sessions, e.id)))).length;
  const waiting = questions.length + stuck.length;

  /** One of mine: a face, a name, how they are and on what; a click opens what they are and what can be done. */
  const person = (e: Employee, state = stateOf(e)) => {
    const session = sessionOfEmployee(s.sessions, e.id);
    const isLead = e.roleKey === 'lead';
    const kept = e.keptBy?.id === me?.id;
    const task = currentTaskOf(s.tasks, e.id);
    const opened = openId === e.id;
    const toggle = () => setOpenId(opened ? null : e.id);
    const hired = isLead ? Object.values(s.employees).filter((x) => !x.archived && x.hiredBy === e.id).length : 0;
    return (
      <div key={e.id} {...(isLead ? { 'data-lead': e.id } : { 'data-mine-employee': e.id })}>
        <div className="k-row k-row-click" role="button" tabIndex={0} aria-expanded={opened} aria-label={`${e.name}: ${opened ? 'hide' : 'show'} more`} onClick={toggle} onKeyDown={(ev) => ev.target === ev.currentTarget && onActivate(toggle)(ev)}>
          <Avatar appearance={e.appearance} size={36} offline={!isLive(session)} />
          <div className="k-main">
            <div className="k-title">
              {e.name}
              {isLead && <span className="k-title-note">team lead</span>}
              {kept && (
                <span className="k-title-note" title="A shared employee you look after: listed among yours, still shared with the office">
                  shared
                </span>
              )}
            </div>
            <div className="k-line">
              <State {...state} title={state.dot === 'off' ? 'No session is running; talking to them or giving them a task wakes them' : 'From real session signals (hooks, MCP reports, process state)'} />
              <span className="k-sub">{isLead ? `hired ${hired} of ${LEAD_HIRE_LIMIT}` : task ? `${task.key} ${task.title}` : ''}</span>
            </div>
          </div>
          <Button
            small
            variant="ghost"
            className="k-quiet"
            onClick={(ev) => {
              ev.stopPropagation();
              open('talk', e.id);
            }}
          >
            Talk
          </Button>
          <span className="k-chev" aria-hidden />
        </div>
        {opened && (
          <div className="k-detail" style={{ paddingLeft: 68, gap: 12, paddingTop: 0 }}>
            <div className="k-sub" style={{ whiteSpace: 'normal' }}>
              {aboutEmployee(e, { project: e.projectId ? s.projects[e.projectId]?.name : null, machine: s.hosts[e.hostId ?? '']?.name, machines: machines.length })}
            </div>
            {isLead && (
              <>
                <div className="k-text">You tell them what you want; they hand it to the one of your employees whose it is, and ask you when that is not clear.</div>
                <label className="check" style={{ alignItems: 'center' }} title="Your own employees are always theirs to direct. With this, the office's shared employees too — on the shared projects, as you may yourself.">
                  <input
                    type="checkbox"
                    style={{ margin: 0 }}
                    checked={e.leadScope === 'office'}
                    onChange={(ev) => act(() => api('PATCH', `/employees/${e.id}`, { leadScope: ev.target.checked ? 'office' : 'own' }), ev.target.checked ? `${e.name} now directs the shared employees too` : `${e.name} now directs your own employees only`)}
                  />
                  <span className="k-sub">Also direct the office's shared employees</span>
                </label>
              </>
            )}
            <div className="k-actions">
              <Button small onClick={() => open('talk', e.id)}>
                Talk
              </Button>
              {!isLead && (
                <Button small onClick={() => s.enterWorkstation(e.id)} disabled={!session} title={session ? 'Sit at their real terminal' : 'No session yet'}>
                  Terminal
                </Button>
              )}
              <Button small onClick={() => open('employee', e.id)}>
                Profile
              </Button>
              <span className="grow" />
              {kept && (
                <Button small variant="ghost" className="k-quiet" onClick={() => act(() => api('POST', `/employees/${e.id}/give-back`, {}), `${e.name} is no longer among yours`)} title="Stop listing them among your own; they stay in the office as they are.">
                  Not mine
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const task = (t: (typeof tasks)[number]) => {
    const whose = whoseTask(s.hosts, me, t, s.projects, s.employees);
    const state = taskState(t.status);
    const who = t.assigneeId ? s.employees[t.assigneeId] : undefined;
    return (
      <button key={t.id} type="button" className="k-row k-row-sm" onClick={() => open('task', t.id)} data-mine-task={t.id} title={`${t.key} ${t.title} — ${who ? who.name : 'unassigned'}${whose.kind !== 'mine' && madeByMe(me, t) ? ', made by you' : ''}`}>
        <span className="k-key">{t.key}</span>
        <span className="k-main">
          <span className="k-title k-title-sm">{t.title}</span>
        </span>
        {/* Somebody's face on it says it is being worked on; a word is for when it stands otherwise. */}
        {t.status !== 'IN_PROGRESS' && <State word={state.word} tone={state.tone} />}
        {who ? <Avatar appearance={who.appearance} size={22} /> : <span className="k-nobody" aria-label="unassigned" />}
      </button>
    );
  };

  return (
    <Window
      kit
      title="My work"
      subtitle={myWorkLine({ employees: employees.length, working, tasks: tasks.length, waiting })}
      onClose={onClose}
      width={1080}
      actions={
        <>
          <Button variant="ghost" className="k-quiet" onClick={() => open('myroom')} title="Your computer in the office, your room and your servers">
            My room
          </Button>
          <Button variant="primary" onClick={() => open('team', 'hire')}>
            Hire
          </Button>
        </>
      }
    >
      <div className="k-stack" data-mine>
        {/* Said only when something does wait: an empty "nothing is waiting" is one more thing to read. */}
        {waiting > 0 && (
          <div className="k-group k-notice" data-mine-waiting aria-label="Waiting for you">
            {questions.map((q) => {
              const who = s.employees[q.employeeId ?? ''];
              return (
                <button key={q.id} type="button" className="k-row k-row-sm" onClick={() => open('question', q.id)}>
                  {who && <Avatar appearance={who.appearance} size={24} />}
                  <span className="k-main">
                    <span className="k-title k-title-sm">{askLine(who?.name, q.kind)}</span>
                  </span>
                  <span className="k-aside">{timeAgo(q.createdAt)}</span>
                  <State word={q.kind === 'permission' ? 'Decide' : 'Answer'} tone="warn" />
                </button>
              );
            })}
            {stuck.map((n) => (
              <button key={n.id} type="button" className="k-row k-row-sm" onClick={() => (n.taskId && s.tasks[n.taskId] ? open('task', n.taskId) : n.employeeId && s.employees[n.employeeId] ? open('employee', n.employeeId) : open('notifications'))}>
                {n.employeeId && s.employees[n.employeeId] && <Avatar appearance={s.employees[n.employeeId]!.appearance} size={24} />}
                <span className="k-main">
                  <span className="k-title k-title-sm">{n.title}</span>
                </span>
                <span className="k-aside">{timeAgo(n.createdAt)}</span>
                <State word={n.kind.replace(/_/g, ' ')} tone={n.severity === 'critical' ? 'bad' : 'warn'} />
              </button>
            ))}
          </div>
        )}

        <div className="k-cols">
          <section className="k-section" data-mine-people>
            <div className="k-head">
              <div className="k-label">People</div>
              {!lead && !hiringLead && (
                <button type="button" className="k-link" onClick={() => setHiringLead(true)} title="One employee you tell what you want; they hand it to the right one of yours">
                  Hire a team lead
                </button>
              )}
            </div>
            {hiringLead && !lead && <LeadForm machines={machines} onClose={() => setHiringLead(false)} />}
            {!lead && employees.length === 0 ? (
              <div className="k-text">
                Nobody works for you alone yet. <b>Hire</b> puts someone onto your own computer or server, and they sit in your room. A shared employee you look after can be listed here too: open them from <b>Team</b> and choose <b>List among mine</b>.
              </div>
            ) : (
              <div className="k-group">
                {lead && person(lead)}
                {people.map((p) => person(p.e, p.state))}
              </div>
            )}
            {machines.length > 0 && (
              <div className="k-chips" data-mine-machines>
                {machines.map((h) => (
                  <button key={h.id} type="button" className="k-chip k-chip-dot" onClick={() => open('myroom')} title={`${h.ownerId ? 'Your server' : 'Your computer'} — open My room`}>
                    <span className={`k-dot ${h.status === 'online' ? '' : 'k-dot-off'}`} aria-hidden />
                    {h.name}
                    {h.status === 'online' ? '' : ' · not here now'}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="k-section" data-mine-tasks>
            <div className="k-head">
              <div className="k-label">Open tasks</div>
              <button type="button" className="k-link" onClick={() => open('tasks')}>
                The board
              </button>
            </div>
            {groups.length === 0 && <div className="k-sub">No open task on your machines, with your employees, or made by you.</div>}
            {groups.map((g) => {
              const of = g.project ? Object.values(s.tasks).filter((t) => t.projectId === g.project!.id && t.kind !== 'review') : [];
              return (
                <div key={g.project?.id ?? 'none'} className="k-group" data-mine-project={g.project?.id}>
                  <button type="button" className="k-row k-row-sm k-row-head" onClick={() => (g.project ? open('projects', g.project.id) : open('tasks'))}>
                    <span className="k-dot" style={{ background: g.project?.color ?? 'var(--faint)', boxShadow: 'none' }} aria-hidden />
                    <span className="k-main">
                      <span className="k-title k-title-sm" style={{ fontWeight: 600 }}>
                        {g.project?.name ?? 'A project that is gone'}
                      </span>
                    </span>
                    {!g.mine && g.project && <WhoseBadge whose={whoseProject(s.hosts, me, g.project)} />}
                    <span className="k-aside">{g.tasks.length + g.more === 0 ? 'nothing open' : projectLine(of.filter((t) => t.status === 'DONE').length, of.length)}</span>
                  </button>
                  {g.tasks.map(task)}
                </div>
              );
            })}
            {unlisted > 0 && (
              <button type="button" className="k-link" style={{ alignSelf: 'flex-start' }} onClick={() => open('tasks')}>
                …and {unlisted} more on the board
              </button>
            )}
          </section>
        </div>
      </div>
    </Window>
  );
}

registerPanel('mine', MinePanel);
