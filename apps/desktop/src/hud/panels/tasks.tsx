import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@orchestrator/contracts';
import { Avatar, Button, Empty, Window, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { TicketNew } from './task-new.tsx';
import { NEEDS, activeEmployees, needOf, plural, type Need, type TicketNeed } from './task-shared.tsx';
import { TicketView, type TicketTab } from './task-view.tsx';
import { EmployeeChanges } from './task-work.tsx';
import './panels-work.css';

// (Other panels take these from here, as they always did.)
export { Person, STATUS_META, TASK_STATUSES, TaskChip, activeEmployees, plural, stamp, useAction } from './task-shared.tsx';

type PanelProps = { arg: string | null; onClose: () => void };

const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'];
/** How many finished tickets the list shows before "show all". */
const DONE_SHOWN = 12;

function order(a: Task, b: Task): number {
  if (a.status === 'DONE') return (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt);
  return PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || b.updatedAt.localeCompare(a.updatedAt);
}

function Row({ task, need, selected, onOpen }: { task: Task; need: TicketNeed; selected: boolean; onOpen: () => void }) {
  const employees = useOffice((s) => s.employees);
  const assignee = task.assigneeId ? employees[task.assigneeId] : undefined;
  const helpers = (task.helperIds ?? []).filter((id) => employees[id] && !employees[id]!.archived);
  const project = useOffice((s) => s.projects[task.projectId]);
  const parent = useOffice((s) => (task.parentId ? s.tasks[task.parentId] : undefined));
  const comments = task.comments?.length ?? 0;
  return (
    <button type="button" className={`tk-row ${selected ? 'on' : ''} tk-row-${need.group}`} onClick={onOpen} aria-current={selected} data-ticket-row={task.key} title={project?.name}>
      <span className="tk-row-bar" style={{ background: need.color }} />
      <span className="tk-row-main">
        <span className="tk-row-top">
          <span className="mono muted">{task.key}</span>
          <span className="tk-row-title">{task.title}</span>
        </span>
        <span className="tk-row-line">
          {need.group !== 'working' && need.group !== 'next' && need.group !== 'done' && <b style={{ color: need.color }}>{need.label} · </b>}
          {need.line}
        </span>
        <span className="tk-row-foot">
          {parent && <span className="tk-tag">part of {parent.key}</span>}
          {!task.parentId && (task.helperIds?.length ?? 0) > 0 && <span className="tk-tag">team</span>}
          {task.priority !== 'normal' && <span className={`tk-tag tk-pri-${task.priority}`}>{task.priority}</span>}
          {task.kind !== 'feature' && <span className="tk-tag">{task.kind}</span>}
          {comments > 0 && <span className="tk-tag tk-count">💬 {comments}</span>}
          <span className="grow" />
          <span className="faint">{timeAgo(task.status === 'DONE' ? (task.completedAt ?? task.updatedAt) : task.updatedAt)}</span>
        </span>
      </span>
      <span className="tk-row-who">
        {assignee ? <Avatar appearance={assignee.appearance} size={26} /> : <span className="tk-nobody" title="Unassigned" />}
        {helpers.length > 0 && <span className="tk-row-plus">+{helpers.length}</span>}
      </span>
    </button>
  );
}

/**
 * Tickets: everything on the left, grouped by what it needs next — what waits for the person at this window comes
 * first — and the open ticket on the right, with its conversation and the one box that does what can be done now.
 * arg: `<taskId>` · `<taskId>:diff` · `new` · `new:<employeeId>`.
 */
function Tickets({ arg, onClose }: PanelProps) {
  const s = useOffice();
  const [assignee, setAssignee] = useState('');
  const [search, setSearch] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const [showReviews, setShowReviews] = useState(false);
  const [head, rest] = (arg ?? '').split(':') as [string, string | undefined];
  const creating = head === 'new';
  const [tab, setTab] = useState<TicketTab>(rest === 'diff' ? 'changes' : 'talk');
  useEffect(() => setTab(rest === 'diff' ? 'changes' : 'talk'), [head, rest]);

  const projects = Object.values(s.projects).sort((a, b) => a.name.localeCompare(b.name));
  const projectId = s.filter.projectId && s.projects[s.filter.projectId] ? s.filter.projectId : null;
  const needle = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const out: Record<Need, Array<{ task: Task; need: TicketNeed }>> = { you: [], working: [], waiting: [], next: [], done: [] };
    for (const t of Object.values(s.tasks)) {
      if (projectId && t.projectId !== projectId) continue;
      if (t.kind === 'review' && !showReviews) continue;
      if (assignee && (assignee === 'none' ? !!t.assigneeId : t.assigneeId !== assignee && !(t.helperIds ?? []).includes(assignee))) continue;
      if (needle && !`${t.key} ${t.title} ${t.description} ${t.kind} ${t.branch ?? ''} ${s.employees[t.assigneeId ?? '']?.name ?? ''}`.toLowerCase().includes(needle)) continue;
      const need = needOf(t, s.employees, s.tasks);
      out[need.group].push({ task: t, need });
    }
    for (const list of Object.values(out)) list.sort((a, b) => order(a.task, b.task));
    // What waits for the person: work to look at and questions first, then what is blocked, proposals last.
    const urgency = (t: Task) => (t.status === 'REVIEW' ? 0 : t.status === 'IN_PROGRESS' || (t.status === 'BLOCKED' && t.waitingFor) ? 1 : t.status === 'BLOCKED' ? 2 : 3);
    out.you.sort((a, b) => urgency(a.task) - urgency(b.task) || order(a.task, b.task));
    return out;
  }, [s.tasks, s.employees, projectId, assignee, needle, showReviews]);

  const selected = !creating && head ? s.tasks[head] : undefined;
  const open = (id: string) => s.openPanel(s.panel === 'tasks' ? 'tasks' : 'task', id);
  // Opened without a ticket in mind: the first one that needs this person, if any.
  const first = groups.you[0]?.task ?? groups.working[0]?.task;
  useEffect(() => {
    if (!arg && first) open(first.id);
  }, [arg, first?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const proposed = groups.you.filter((x) => !x.task.released && x.task.status === 'BACKLOG').map((x) => x.task);
  const reviewCount = Object.values(s.tasks).filter((t) => t.kind === 'review' && (!projectId || t.projectId === projectId)).length;
  const total = NEEDS.reduce((n, g) => n + groups[g.id].length, 0);

  return (
    <Window
      title="Tickets"
      subtitle={groups.you.length ? `${plural(groups.you.length, 'ticket')} ${groups.you.length === 1 ? 'needs' : 'need'} you` : 'Nothing is waiting for you'}
      onClose={onClose}
      width={1400}
      flush
      actions={
        <Button variant="primary" small onClick={() => s.openPanel(s.panel === 'tasks' ? 'tasks' : 'task', 'new')} disabled={!projects.length} title={projects.length ? undefined : 'Create a project first'}>
          New ticket
        </Button>
      }
    >
      <div className="pw-frame tk-frame">
        <div className="tk-side">
          <div className="tk-filters">
            <input type="search" aria-label="Search tickets" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="tk-filters-row">
              <select aria-label="Project" value={projectId ?? ''} onChange={(e) => s.setFilter({ projectId: e.target.value || null })}>
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.status !== 'active' ? ` (${p.status})` : ''}
                  </option>
                ))}
              </select>
              <select aria-label="Employee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Everyone</option>
                <option value="none">Unassigned</option>
                {activeEmployees(s.employees).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="tk-filters-row small">
              <label className="check" title="Only the tickets that wait for you: to review, to answer, to release">
                <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Only what needs me
              </label>
              {reviewCount > 0 && (
                <label className="check" title="The reviews the office makes for a colleague to look at finished work">
                  <input type="checkbox" checked={showReviews} onChange={(e) => setShowReviews(e.target.checked)} /> Reviews ({reviewCount})
                </label>
              )}
            </div>
          </div>
          <div className="tk-list" data-ticket-list>
            {projects.length === 0 ? (
              <Empty title="No projects yet">
                Tickets belong to a project.{' '}
                <button type="button" className="pw-chip" onClick={() => s.openPanel('projects')}>
                  Create a project
                </button>
              </Empty>
            ) : total === 0 ? (
              <Empty title={needle || assignee || projectId ? 'No ticket matches' : 'No tickets yet'}>{needle || assignee || projectId ? 'Nothing fits the search and the filters above.' : 'Create the first one with "New ticket".'}</Empty>
            ) : (
              NEEDS.filter((g) => !onlyMine || g.id === 'you').map((g) => {
                const list = groups[g.id];
                const shown = g.id === 'done' && !allDone && !needle ? list.slice(0, DONE_SHOWN) : list;
                if (!list.length && g.id !== 'you') return null;
                return (
                  <section key={g.id} className={`tk-group tk-group-${g.id}`} data-ticket-group={g.id}>
                    <header>
                      <span>{g.label}</span>
                      <span className="tk-group-n">{list.length}</span>
                      {g.id === 'you' && proposed.length > 1 && (
                        <button type="button" className="tk-link" onClick={() => act(() => api('POST', '/tasks/release', { ids: proposed.map((t) => t.id) }), `${plural(proposed.length, 'ticket')} released`)}>
                          Release {proposed.length} proposed
                        </button>
                      )}
                    </header>
                    {list.length === 0 && <div className="tk-group-empty small faint">{g.empty}</div>}
                    {shown.map(({ task, need }) => (
                      <Row key={task.id} task={task} need={need} selected={selected?.id === task.id} onOpen={() => open(task.id)} />
                    ))}
                    {shown.length < list.length && (
                      <button type="button" className="tk-link tk-more-done" onClick={() => setAllDone(true)}>
                        Show all {list.length} finished
                      </button>
                    )}
                  </section>
                );
              })
            )}
          </div>
        </div>
        {creating ? (
          <TicketNew key={arg} employeeId={rest ?? null} onCreated={(t) => open(t.id)} onCancel={() => s.openPanel(s.panel === 'tasks' ? 'tasks' : 'task', selected?.id ?? first?.id ?? null)} />
        ) : selected ? (
          <TicketView key={selected.id} task={selected} tab={tab} onTab={setTab} />
        ) : (
          <div className="tk-pane tk-pane-pad">
            <Empty title={head ? 'This ticket is no longer here' : 'Choose a ticket'}>{head ? 'It may have been deleted.' : 'Its conversation, and what can be done with it, opens here.'}</Empty>
          </div>
        )}
      </div>
    </Window>
  );
}

/** arg: `<taskId>` · `<taskId>:diff` · `new` · `new:<employeeId>` · `diff:<employeeId>` (an employee's working tree). */
function TaskPanel({ arg, onClose }: PanelProps) {
  const [head, rest] = (arg ?? '').split(':') as [string, string | undefined];
  if (head === 'diff' && rest) return <EmployeeChanges key={arg} employeeId={rest} onClose={onClose} />;
  return <Tickets arg={arg} onClose={onClose} />;
}

registerPanel('tasks', TaskPanel);
registerPanel('task', TaskPanel);
