import { useState } from 'react';
import type { Task, TaskPriority, TaskStatus } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Progress, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { TicketNew } from './task-new.tsx';
import { STATUS_META, TASK_STATUSES, activeEmployees, needOf, plural } from './task-shared.tsx';
import { TicketView, type TicketTab } from './task-view.tsx';
import { EmployeeChanges } from './task-work.tsx';
import './panels-work.css';

// (Other panels take these from here, as they always did.)
export { Person, STATUS_META, TASK_STATUSES, TaskChip, activeEmployees, plural, stamp, useAction } from './task-shared.tsx';

type PanelProps = { arg: string | null; onClose: () => void };

// ─────────────────────────────── board ───────────────────────────────

const PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal', 'low'];
const PRIORITY_TONE: Record<TaskPriority, Tone> = { urgent: 'bad', high: 'warn', normal: 'neutral', low: 'muted' };

function boardOrder(a: Task, b: Task): number {
  if (a.status === 'DONE') return (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt);
  return PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || b.updatedAt.localeCompare(a.updatedAt);
}

/** A manual board move. The server decides what is legal; marking DONE by hand is spelled out first. */
async function moveTask(taskId: string, status: TaskStatus): Promise<void> {
  const task = useOffice.getState().tasks[taskId];
  if (!task || task.status === status) return;
  if (status === 'DONE' && !(await ask({ title: `Mark ${task.key} as done by hand?`, body: 'Nobody will have checked it. The record will say it was marked done by hand, not verified.', ok: 'Mark as done' }))) return;
  void act(() => api('PATCH', `/tasks/${taskId}`, { status }), `${task.key} moved to ${STATUS_META[status].label}`);
}

function TaskCard({ task, onDrag }: { task: Task; onDrag: (id: string | null) => void }) {
  const project = useOffice((s) => s.projects[task.projectId]);
  const employees = useOffice((s) => s.employees);
  const tasks = useOffice((s) => s.tasks);
  const open = () => useOffice.getState().openPanel('task', task.id);
  const need = needOf(task, employees, tasks);
  const assignee = task.assigneeId ? employees[task.assigneeId] : undefined;
  const helpers = (task.helperIds ?? []).filter((id) => employees[id] && !employees[id]!.archived).length;
  const parent = task.parentId ? tasks[task.parentId] : undefined;
  const parts = Object.values(tasks).filter((t) => t.parentId === task.id);
  const comments = task.comments?.length ?? 0;
  return (
    <div
      className={`tcard ${need.group === 'you' && task.status !== 'BACKLOG' ? 'tcard-you' : ''}`}
      style={{ borderLeftColor: project?.color }}
      role="button"
      tabIndex={0}
      draggable
      data-ticket-card={task.key}
      title={project ? `${project.name} · click to open, drag to another column to move` : undefined}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
        onDrag(task.id);
      }}
      onDragEnd={() => onDrag(null)}
    >
      {/* The key never breaks, and the tags wrap under it rather than run out of the card. Priority is said only when it is not the ordinary one. */}
      <div className="tcard-head">
        <span className="mono muted tcard-key">{task.key}</span>
        <span className="tcard-tags">
          {!task.released && (
            <Badge tone="warn" title="Proposed: waits for your release before it is scheduled">
              proposed
            </Badge>
          )}
          {parent && <Badge tone="muted">part of {parent.key}</Badge>}
          <Badge tone="muted">{task.kind}</Badge>
          {task.priority !== 'normal' && <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority}</Badge>}
        </span>
      </div>
      <div className="tcard-title">{task.title}</div>
      {/* What it waits for, when it waits for the person at this window: said on the card, in the column it is in. */}
      {need.group === 'you' && task.status !== 'BACKLOG' && (
        <div className="tcard-need small" data-card-need>
          <b>{need.label}</b> · {need.line}
        </div>
      )}
      {need.group === 'waiting' && <div className="small muted tcard-wait">{need.line}</div>}
      {task.progress.percent != null && task.status !== 'BLOCKED' && <Progress value={task.progress.percent} tone={task.status === 'DONE' ? 'good' : 'info'} />}
      <div className="row spread small" style={{ marginTop: 4 }}>
        <span className="row" style={{ gap: 6, minWidth: 0 }}>
          {assignee ? (
            <>
              <Avatar appearance={assignee.appearance} size={18} />
              <span className="truncate">{assignee.name}</span>
              {helpers > 0 && <span className="muted">+{helpers}</span>}
            </>
          ) : (
            <span className="muted">unassigned{task.roleHint ? ` · ${task.roleHint}` : ''}</span>
          )}
        </span>
        <span className="row faint" style={{ gap: 8, flex: 'none' }}>
          {parts.length > 0 && (
            <span title={`${parts.filter((p) => p.status === 'DONE').length} of ${parts.length} parts done`}>
              ◫ {parts.filter((p) => p.status === 'DONE').length}/{parts.length}
            </span>
          )}
          {comments > 0 && <span title={plural(comments, 'comment')}>💬 {comments}</span>}
          {task.attempts > 0 && <span title="Times this task was sent back after a failed check or a review">↩ {task.attempts}</span>}
        </span>
      </div>
    </div>
  );
}

function TasksPanel({ onClose }: PanelProps) {
  const s = useOffice();
  const [assignee, setAssignee] = useState('');
  const [search, setSearch] = useState('');
  const [showReviews, setShowReviews] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);

  const projects = Object.values(s.projects).sort((a, b) => a.name.localeCompare(b.name));
  const projectId = s.filter.projectId && s.projects[s.filter.projectId] ? s.filter.projectId : null;
  const inProject = Object.values(s.tasks).filter((t) => !projectId || t.projectId === projectId);
  const proposed = inProject.filter((t) => !t.released && t.status === 'BACKLOG');
  const reviewCount = inProject.filter((t) => t.kind === 'review').length;
  const mine = new Set(inProject.filter((t) => t.kind !== 'review' && needOf(t, s.employees, s.tasks).group === 'you').map((t) => t.id));
  const needle = search.trim().toLowerCase();
  const shown = inProject.filter(
    (t) =>
      (showReviews || t.kind !== 'review') &&
      (!onlyMine || mine.has(t.id)) &&
      (!assignee || (assignee === 'none' ? !t.assigneeId : t.assigneeId === assignee || (t.helperIds ?? []).includes(assignee))) &&
      (!needle || `${t.key} ${t.title} ${t.description} ${t.kind} ${t.branch ?? ''} ${s.employees[t.assigneeId ?? '']?.name ?? ''}`.toLowerCase().includes(needle)),
  );

  return (
    <Window title="Tasks" subtitle="Cards move by themselves as work is done and checked. Click one to open it and talk on it; drag one to move it by hand." onClose={onClose} width={1320} flush>
      <div className="pw-frame">
        <div className="pw-toolbar">
          <input type="search" aria-label="Search tasks" placeholder="Search tasks…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 190 }} />
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
          <label className={`check small ${mine.size ? 'tk-needs-me' : ''}`} title="Only the tasks that wait for you: to review, to answer, to unblock, to release">
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Needs me ({mine.size})
          </label>
          <label className="check small" title="Review tasks are created by Orchestrator for a task under review">
            <input type="checkbox" checked={showReviews} onChange={(e) => setShowReviews(e.target.checked)} /> Show review tasks ({reviewCount})
          </label>
          <div className="grow" />
          {proposed.length > 0 && (
            <Button
              variant="success"
              title="Released tasks are scheduled as soon as their dependencies are done"
              onClick={() => act(() => api('POST', '/tasks/release', { ids: proposed.map((t) => t.id) }), `${plural(proposed.length, 'task')} released for scheduling`)}
            >
              Release {plural(proposed.length, 'proposed task')}
            </Button>
          )}
          <Button variant="primary" onClick={() => s.openPanel('task', 'new')} disabled={!projects.length} title={projects.length ? undefined : 'Create a project first'}>
            New task
          </Button>
        </div>
        {projects.length === 0 ? (
          <Empty title="No projects yet">
            Tasks belong to a project.{' '}
            <button type="button" className="pw-chip" onClick={() => s.openPanel('projects')}>
              Create a project
            </button>
          </Empty>
        ) : (
          <div className="board">
            {TASK_STATUSES.map((status) => {
              const tasks = shown.filter((t) => t.status === status).sort(boardOrder);
              const meta = STATUS_META[status];
              return (
                <div
                  key={status}
                  className={`board-col ${over === status ? 'board-col-drop' : ''}`}
                  onDragOver={(e) => {
                    if (!dragging) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (over !== status) setOver(status);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData('text/plain') || dragging;
                    setOver(null);
                    setDragging(null);
                    if (id) moveTask(id, status);
                  }}
                >
                  <div className="board-col-head" style={{ borderBottomColor: meta.color }}>
                    <span style={{ color: meta.color }}>{meta.label.toUpperCase()}</span>
                    <span className="muted">{tasks.length}</span>
                  </div>
                  <div className="board-col-body">
                    {tasks.map((t) => (
                      <TaskCard key={t.id} task={t} onDrag={setDragging} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Window>
  );
}

// ───────────────────────────── one task ─────────────────────────────

function Ticket({ id, initialTab, onClose }: { id: string; initialTab: TicketTab; onClose: () => void }) {
  const task = useOffice((s) => s.tasks[id]);
  const project = useOffice((s) => (task ? s.projects[task.projectId] : undefined));
  const [tab, setTab] = useState<TicketTab>(initialTab);
  if (!task) {
    return (
      <Window title="Task" onClose={onClose} width={520}>
        <Empty title="This task is not on the board">It may have been deleted.</Empty>
      </Window>
    );
  }
  return (
    <Window
      title={
        <>
          <span className="mono muted">{task.key}</span> {task.title}
        </>
      }
      subtitle={`${project?.name ?? 'Unknown project'} · updated ${timeAgo(task.updatedAt)}`}
      onClose={onClose}
      width={1180}
      flush
      actions={
        <Button small variant="ghost" onClick={() => useOffice.getState().openPanel('tasks')}>
          All tasks
        </Button>
      }
    >
      <div className="pw-frame tk-frame">
        <TicketView task={task} tab={tab} onTab={setTab} />
      </div>
    </Window>
  );
}

function NewTicket({ employeeId, onClose }: { employeeId: string | null; onClose: () => void }) {
  const preset = useOffice((s) => (employeeId ? s.employees[employeeId] : undefined));
  return (
    <Window title="New task" subtitle={preset ? `For ${preset.name} · ${preset.title}` : 'Given to an employee; reviewed when it is handed in'} onClose={onClose} width={760} flush>
      <div className="pw-frame tk-frame tk-frame-new">
        <TicketNew employeeId={employeeId} onCreated={(t) => useOffice.getState().openPanel('task', t.id)} onCancel={onClose} />
      </div>
    </Window>
  );
}

/** arg: `<taskId>` · `<taskId>:diff` · `new` · `new:<employeeId>` · `diff:<employeeId>` */
function TaskPanel({ arg, onClose }: PanelProps) {
  if (!arg) return null;
  const [head, rest] = arg.split(':') as [string, string | undefined];
  if (head === 'new') return <NewTicket key={arg} employeeId={rest ?? null} onClose={onClose} />;
  if (head === 'diff' && rest) return <EmployeeChanges key={arg} employeeId={rest} onClose={onClose} />;
  return <Ticket key={arg} id={head} initialTab={rest === 'diff' ? 'changes' : 'talk'} onClose={onClose} />;
}

registerPanel('tasks', TasksPanel);
registerPanel('task', TaskPanel);
