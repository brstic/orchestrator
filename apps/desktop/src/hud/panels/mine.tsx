import { useMemo, useState } from 'react';
import type { Employee, Host } from '@orchestrator/contracts';
import { LEAD_HIRE_LIMIT } from '@orchestrator/contracts';
import { Avatar, Button, Window, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { act } from '../core.tsx';
import { activityOf, currentTaskOf, openQuestionsOf, sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { NEEDS_KINDS } from '../../lib/attention.ts';
import { madeByMe, taskIsMine, whoseEmployee, whoseHost, whoseProject, whoseTask } from '../../lib/mine.ts';
import { OPEN_ORDER, aboutEmployee, askLine, employeeState, myWorkLine, projectLine, taskState } from '../../lib/my-work.ts';
import { WhoseBadge } from '../mine.tsx';
import { isLive, isWorking } from './company-shared.tsx';
import { registerPanel } from './index.tsx';
import { More, State } from './kit.tsx';

/** How many open tasks stand in the window before the rest is folded. */
const TASKS_SHOWN = 8;
const TASKS_MOST = 40;

/** How an employee is, as the dot and the word at the end of their line. */
function EmployeeState({ employee }: { employee: Employee }) {
  const session = useOffice((s) => sessionOfEmployee(s.sessions, employee.id));
  const asks = useOffice((s) => openQuestionsOf(s.questions, employee.id).length > 0);
  const state = employeeState(activityOf(session), asks);
  return <State {...state} width={124} title={state.dot === 'off' ? 'No session is running; talking to them or giving them a task wakes them' : 'From real session signals (hooks, MCP reports, process state)'} />;
}

/**
 * The member's team lead: the one they tell what they want, who hands it to the right one of their employees. A
 * line like any employee's, and under it the one thing that is set here: whether it directs the shared employees
 * too. Where there is none yet, the way to get one.
 */
function Lead({ lead, machines, hired }: { lead: Employee | undefined; machines: Host[]; hired: number }) {
  const s = useOffice();
  const [asking, setAsking] = useState(false);
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
      <div className="k-group" data-lead="none">
        {!asking ? (
          <div className="k-row">
            <div className="k-main">
              <div className="k-title">No team lead yet</div>
              <div className="k-sub">One employee you tell what you want; they hand it to the right one of yours.</div>
            </div>
            <Button small disabled={!home} onClick={() => setAsking(true)} title={home ? `On ${home.name}` : 'None of your machines is in the office right now'}>
              Hire a team lead
            </Button>
          </div>
        ) : (
          <form
            className="k-detail"
            style={{ padding: 16 }}
            onSubmit={(ev) => {
              ev.preventDefault();
              if (!busy) void hire();
            }}
          >
            <div className="k-text">
              You tell them what you want — "look at the tickets for this project", "check that domain" — and they hand it to the one of your employees whose it is, and ask you when that is not clear. When nobody fits they may hire, up to{' '}
              {LEAD_HIRE_LIMIT} people onto your machines. They run on the lightest model, and only when you speak to them.
            </div>
            <div className="k-actions">
              <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder={`${s.me?.name ?? 'My'} Lead`} aria-label="Name of your team lead" style={{ width: 220 }} maxLength={40} autoFocus />
              {/* (Not blue: the window's one main button is Hire, above.) */}
              <Button small type="submit" disabled={busy || !home}>
                {busy ? 'Hiring…' : `Hire onto ${home?.name ?? 'your machine'}`}
              </Button>
              <Button small variant="ghost" type="button" className="k-quiet" disabled={busy} onClick={() => setAsking(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    );
  }
  const wide = lead.leadScope === 'office';
  return (
    <div className="k-group" data-lead={lead.id}>
      <div className="k-row">
        <Avatar appearance={lead.appearance} size={32} offline={!isLive(sessionOfEmployee(s.sessions, lead.id))} />
        <div className="k-main">
          <div className="k-title">{lead.name}</div>
          <div className="k-sub" title="Tell them what you want; they hand it to the one of your employees whose it is">
            Hands your wishes to the right one · hired {hired} of {LEAD_HIRE_LIMIT} · {lead.model ?? 'default model'}
          </div>
        </div>
        <EmployeeState employee={lead} />
        <Button small onClick={() => s.openPanel('talk', lead.id)}>
          Talk
        </Button>
        <Button small variant="ghost" className="k-quiet" onClick={() => s.openPanel('employee', lead.id)}>
          Profile
        </Button>
      </div>
      <label className="k-row k-row-sm check" style={{ cursor: 'pointer', alignItems: 'center' }} title="Your own employees are always theirs to direct. With this, the office's shared employees too — on the shared projects, as you may yourself.">
        <input
          type="checkbox"
          style={{ margin: 0 }}
          checked={wide}
          disabled={busy}
          onChange={(ev) => act(() => api('PATCH', `/employees/${lead.id}`, { leadScope: ev.target.checked ? 'office' : 'own' }), ev.target.checked ? `${lead.name} now directs the shared employees too` : `${lead.name} now directs your own employees only`)}
        />
        <span className="k-sub">Also direct the office's shared employees</span>
      </label>
    </div>
  );
}

/**
 * One's own part of a shared office, in one window (docs/UI.md is the look): what waits for me — only when
 * something does — my team lead, my employees, my open tasks, my projects and my machines. Everything here is also
 * in the office's own lists (Team, Tasks, Projects — "Everyone"); this is where someone who has just come in starts.
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
  const working = employees.filter((e) => isWorking(activityOf(sessionOfEmployee(s.sessions, e.id)))).length;
  const waiting = questions.length + stuck.length;

  const person = (e: Employee) => {
    const session = sessionOfEmployee(s.sessions, e.id);
    const kept = e.keptBy?.id === me?.id;
    return (
      <div key={e.id} className="k-row" data-mine-employee={e.id}>
        <Avatar appearance={e.appearance} size={32} offline={!isLive(session)} />
        <div className="k-main">
          <div className="k-title">
            {e.name}
            {/* The exception is said on the name's own line, with the way back beside it. */}
            {kept && (
              <>
                <span className="k-title-note">shared, looked after by you</span>
                <button type="button" className="k-link" onClick={() => act(() => api('POST', `/employees/${e.id}/give-back`, {}), `${e.name} is no longer among yours`)} title="Stop listing them among your own; they stay in the office as they are.">
                  Not mine
                </button>
              </>
            )}
          </div>
          <div className="k-sub">{aboutEmployee(e, { project: e.projectId ? s.projects[e.projectId]?.name : null, machine: s.hosts[e.hostId ?? '']?.name, machines: machines.length, task: currentTaskOf(s.tasks, e.id) })}</div>
        </div>
        <EmployeeState employee={e} />
        <Button small onClick={() => open('talk', e.id)}>
          Talk
        </Button>
        <Button small variant="ghost" className="k-quiet" onClick={() => s.enterWorkstation(e.id)} disabled={!session} title={session ? 'Sit at their real terminal' : 'No session yet'}>
          Terminal
        </Button>
        <Button small variant="ghost" className="k-quiet" onClick={() => open('employee', e.id)}>
          Profile
        </Button>
      </div>
    );
  };

  const task = (t: (typeof tasks)[number]) => {
    const whose = whoseTask(s.hosts, me, t, s.projects, s.employees);
    const state = taskState(t.status);
    return (
      <button key={t.id} type="button" className="k-row k-row-sm" onClick={() => open('task', t.id)} data-mine-task={t.id}>
        <span className="k-key">{t.key}</span>
        <span className="k-main">
          <span className="k-title" style={{ fontSize: 13.5, fontWeight: 500 }}>
            {t.title}
          </span>
        </span>
        {whose.kind !== 'mine' && <WhoseBadge whose={whose} />}
        {whose.kind !== 'mine' && madeByMe(me, t) && <span className="k-aside">made by you</span>}
        <span className="k-aside">{[s.projects[t.projectId]?.name, t.assigneeId && s.employees[t.assigneeId] ? s.employees[t.assigneeId]!.name : 'unassigned'].filter(Boolean).join(' · ')}</span>
        <State word={state.word} tone={state.tone} width={78} />
      </button>
    );
  };

  return (
    <Window
      kit
      title="My work"
      subtitle={myWorkLine({ employees: employees.length, working, tasks: tasks.length, waiting })}
      onClose={onClose}
      width={900}
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
          <section className="k-section" data-mine-waiting>
            <div className="k-label">Waiting for you</div>
            <div className="k-group k-notice">
              {questions.map((q) => {
                const who = s.employees[q.employeeId ?? ''];
                return (
                  <button key={q.id} type="button" className="k-row k-row-sm" onClick={() => open('question', q.id)}>
                    {who && <Avatar appearance={who.appearance} size={24} />}
                    <span className="k-main">
                      <span className="k-title" style={{ fontSize: 13.5, fontWeight: 500 }}>
                        {askLine(who?.name, q.kind)}
                      </span>
                    </span>
                    <span className="k-aside">{timeAgo(q.createdAt)}</span>
                    <State word={q.kind === 'permission' ? 'approval' : 'question'} tone="warn" width={78} />
                  </button>
                );
              })}
              {stuck.map((n) => (
                <button key={n.id} type="button" className="k-row k-row-sm" onClick={() => (n.taskId && s.tasks[n.taskId] ? open('task', n.taskId) : n.employeeId && s.employees[n.employeeId] ? open('employee', n.employeeId) : open('notifications'))}>
                  {n.employeeId && s.employees[n.employeeId] && <Avatar appearance={s.employees[n.employeeId]!.appearance} size={24} />}
                  <span className="k-main">
                    <span className="k-title" style={{ fontSize: 13.5, fontWeight: 500 }}>
                      {n.title}
                    </span>
                  </span>
                  <span className="k-aside">{timeAgo(n.createdAt)}</span>
                  <State word={n.kind.replace(/_/g, ' ')} tone={n.severity === 'critical' ? 'bad' : 'warn'} width={78} />
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="k-section">
          <div className="k-label">Team lead</div>
          <Lead lead={lead} machines={machines} hired={Object.values(s.employees).filter((e) => !e.archived && !!lead && e.hiredBy === lead.id).length} />
        </section>

        <section className="k-section">
          <div className="k-label">Employees</div>
          {employees.length === 0 ? (
            <div className="k-text">
              Nobody works for you alone yet. <b>Hire</b> puts someone onto your own computer or server, and they sit in your room. A shared employee you look after can be listed here too: <b>Team → Everyone</b>, then <b>Mine</b> on their row.
            </div>
          ) : (
            <div className="k-group">{employees.map(person)}</div>
          )}
        </section>

        <section className="k-section">
          <div className="k-head">
            <div className="k-label">Open tasks</div>
            <button type="button" className="k-link" onClick={() => open('tasks')}>
              The board
            </button>
          </div>
          {tasks.length === 0 ? (
            <div className="k-sub">No open task on your machines, with your employees, or made by you.</div>
          ) : (
            <>
              <div className="k-group">{tasks.slice(0, TASKS_SHOWN).map(task)}</div>
              {tasks.length > TASKS_SHOWN && (
                <More summary={`${tasks.length - TASKS_SHOWN} more`}>
                  <div className="k-group">{tasks.slice(TASKS_SHOWN, TASKS_MOST).map(task)}</div>
                  {tasks.length > TASKS_MOST && <div className="k-sub">…and {tasks.length - TASKS_MOST} more on the board.</div>}
                </More>
              )}
            </>
          )}
        </section>

        <div className="k-cols">
          <section className="k-section">
            <div className="k-label">Projects</div>
            {projects.length === 0 ? (
              <div className="k-sub">No project lives on your machines.</div>
            ) : (
              <div className="k-group">
                {projects.map((p) => {
                  const of = Object.values(s.tasks).filter((t) => t.projectId === p.id && t.kind !== 'review');
                  return (
                    <button key={p.id} type="button" className="k-row k-row-sm" onClick={() => open('projects', p.id)}>
                      <span className="k-dot" style={{ background: p.color, boxShadow: 'none' }} aria-hidden />
                      <span className="k-main">
                        <span className="k-title" style={{ fontSize: 13.5 }}>
                          {p.name}
                        </span>
                      </span>
                      <span className="k-aside">{projectLine(of.filter((t) => t.status === 'DONE').length, of.length)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
          <section className="k-section">
            <div className="k-label">Machines</div>
            {machines.length === 0 ? (
              <div className="k-sub">None of your machines is in this office.</div>
            ) : (
              <div className="k-group">
                {machines.map((h) => (
                  <button key={h.id} type="button" className="k-row k-row-sm" onClick={() => open('myroom')} title="Open My room">
                    <span className={`k-dot ${h.status === 'online' ? '' : 'k-dot-off'}`} aria-hidden />
                    <span className="k-main">
                      <span className="k-title" style={{ fontSize: 13.5 }}>
                        {h.name}
                      </span>
                    </span>
                    {/* Lit says it is here; "computer" is in every member's machine's name. */}
                    <span className="k-aside">{[h.ownerId ? 'server' : null, h.status === 'online' ? null : 'not here now'].filter(Boolean).join(' · ')}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </Window>
  );
}

registerPanel('mine', MinePanel);
