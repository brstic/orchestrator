import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DeliveryState, Employee, EvidenceProvenance, OrchestratorEvent, Task, TaskKind, TaskPriority, TaskStatus } from '@orchestrator/contracts';
import { ROLE_CATALOGUE, formatDuration } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Field, Markdown, Progress, Provenance, Stat, Tabs, Window, clock, timeAgo, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { PendingFiles, TaskFiles, uploadFile } from './task-files.tsx';
import './panels-work.css';

type PanelProps = { arg: string | null; onClose: () => void };

// ───────────────────── shared by the work panels ─────────────────────

export const TASK_STATUSES: TaskStatus[] = ['BACKLOG', 'READY', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'DONE'];

export const STATUS_META: Record<TaskStatus, { label: string; tone: Tone; color: string }> = {
  BACKLOG: { label: 'Backlog', tone: 'muted', color: 'var(--faint)' },
  READY: { label: 'Ready', tone: 'info', color: 'var(--accent)' },
  IN_PROGRESS: { label: 'In progress', tone: 'accent', color: 'var(--violet)' },
  REVIEW: { label: 'Review', tone: 'warn', color: 'var(--warn)' },
  BLOCKED: { label: 'Blocked', tone: 'bad', color: 'var(--bad)' },
  DONE: { label: 'Done', tone: 'good', color: 'var(--good)' },
};

/** `act` plus a busy flag, so buttons can be disabled while a call is in flight. */
export function useAction(): [boolean, <T>(fn: () => Promise<T>, ok?: string) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string) => {
    setBusy(true);
    const res = await act(fn, ok);
    setBusy(false);
    return res;
  }, []);
  return [busy, run];
}

export function activeEmployees(employees: Record<string, Employee>): Employee[] {
  return Object.values(employees)
    .filter((e) => !e.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Date and time of a record, compact. */
export function stamp(iso: string): string {
  return `${new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(iso)}`;
}

export function Person({ id, size = 22, fallback = 'unassigned' }: { id: string | null | undefined; size?: number; fallback?: string }) {
  const e = useOffice((s) => (id ? s.employees[id] : undefined));
  if (!e) return <span className="muted">{fallback}</span>;
  return (
    <span className="row" style={{ gap: 6, minWidth: 0 }}>
      <Avatar appearance={e.appearance} size={size} />
      <span className="truncate">{e.name}</span>
    </span>
  );
}

/** A task reference that opens the task. */
export function TaskChip({ id }: { id: string }) {
  const task = useOffice((s) => s.tasks[id]);
  if (!task) return <Badge tone="muted" title="This task is no longer on the board">removed task</Badge>;
  return (
    <button type="button" className="pw-chip" title={`${task.title} — ${STATUS_META[task.status].label}`} onClick={() => useOffice.getState().openPanel('task', id)}>
      <span className="dot" style={{ background: STATUS_META[task.status].color }} />
      <span className="mono">{task.key}</span>
      <span className="truncate">{task.title}</span>
    </button>
  );
}

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
  const open = () => useOffice.getState().openPanel('task', task.id);
  return (
    <div
      className="tcard"
      style={{ borderLeftColor: project?.color }}
      role="button"
      tabIndex={0}
      draggable
      title={project ? `${project.name} · drag to another column to move` : undefined}
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
          <Badge tone="muted">{task.kind}</Badge>
          {task.priority !== 'normal' && <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority}</Badge>}
        </span>
      </div>
      <div className="tcard-title">{task.title}</div>
      {task.status === 'BLOCKED' && task.blockedReason && (
        <div className="small truncate" style={{ color: '#ff9aa9', marginBottom: 5 }}>
          {task.blockedReason}
        </div>
      )}
      {task.progress.percent != null && <Progress value={task.progress.percent} tone={task.status === 'DONE' ? 'good' : 'info'} />}
      <div className="row spread small" style={{ marginTop: 4 }}>
        <Person id={task.assigneeId} size={18} fallback={`unassigned${task.roleHint ? ` · ${task.roleHint}` : ''}`} />
        {task.attempts > 0 && (
          <span className="faint" title="Times this task was sent back after a failed verification or a rejected review">
            {plural(task.attempts, 'retry', 'retries')}
          </span>
        )}
      </div>
    </div>
  );
}

function TasksPanel({ onClose }: PanelProps) {
  const s = useOffice();
  const [assignee, setAssignee] = useState('');
  const [search, setSearch] = useState('');
  const [showReviews, setShowReviews] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);

  const projects = Object.values(s.projects).sort((a, b) => a.name.localeCompare(b.name));
  const projectId = s.filter.projectId && s.projects[s.filter.projectId] ? s.filter.projectId : null;
  const inProject = Object.values(s.tasks).filter((t) => !projectId || t.projectId === projectId);
  const proposed = inProject.filter((t) => !t.released && t.status === 'BACKLOG');
  const reviewCount = inProject.filter((t) => t.kind === 'review').length;
  const needle = search.trim().toLowerCase();
  const shown = inProject.filter(
    (t) =>
      (showReviews || t.kind !== 'review') &&
      (!assignee || (assignee === 'none' ? !t.assigneeId : t.assigneeId === assignee)) &&
      (!needle || `${t.key} ${t.title} ${t.description} ${t.kind} ${t.branch ?? ''} ${s.employees[t.assigneeId ?? '']?.name ?? ''}`.toLowerCase().includes(needle)),
  );

  return (
    <Window title="Tasks" subtitle="Cards move by themselves as work is done and checked. Drag one to move it by hand." onClose={onClose} width={1320} flush>
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

// ───────────────────────────── new task ──────────────────────────────

/** Review tasks are created by Orchestrator for a specific task under review, never by hand. */
const CREATABLE_KINDS: TaskKind[] = ['feature', 'bug', 'test', 'research', 'planning', 'security', 'docs', 'ops', 'refactor', 'chore'];
/** Kinds that produce documents rather than commits; the server never requires a review for them by default. */
const NON_CODE_KINDS: TaskKind[] = ['research', 'planning'];

function TaskCreate({ employeeId, onClose }: { employeeId: string | null; onClose: () => void }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const projects = Object.values(s.projects)
    .filter((p) => p.status !== 'archived')
    .sort((a, b) => a.name.localeCompare(b.name));
  const preset = employeeId ? s.employees[employeeId] : undefined;
  const [projectId, setProjectId] = useState(() => {
    const wanted = preset?.projectId ?? s.filter.projectId;
    return projects.find((p) => p.id === wanted)?.id ?? (projects.length === 1 ? projects[0]!.id : '');
  });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [kind, setKind] = useState<TaskKind>('feature');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [assigneeId, setAssigneeId] = useState(preset?.id ?? '');
  const [roleHint, setRoleHint] = useState('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  /** null = leave it to the project's review policy. */
  const [requiresReview, setRequiresReview] = useState<boolean | null>(null);
  const [released, setReleased] = useState(true);
  const [more, setMore] = useState(false);

  const project = projectId ? s.projects[projectId] : undefined;
  const reviewDefault = !!project?.policy.requireReview && !NON_CODE_KINDS.includes(kind);
  const candidates = Object.values(s.tasks)
    .filter((t) => t.projectId === projectId && t.kind !== 'review')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  /** What differs from the usual inside the folded part, so nothing set there goes unseen. */
  const changed = [
    acceptance.trim() ? 'acceptance criteria' : '',
    kind !== 'feature' ? kind : '',
    priority !== 'normal' ? `${priority} priority` : '',
    dependsOn.length ? `depends on ${dependsOn.length}` : '',
    requiresReview !== null ? (requiresReview ? 'review required' : 'no review') : '',
    released ? '' : 'kept in the backlog',
  ].filter(Boolean);

  const [files, setFiles] = useState<File[]>([]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!projectId || !title.trim() || busy) return;
    const created = await run(() =>
      api<Task>('POST', '/tasks', {
        projectId,
        title,
        description,
        acceptance,
        kind,
        priority,
        assigneeId: assigneeId || null,
        roleHint: assigneeId ? null : roleHint || null,
        dependsOn,
        // With files, the task is held until they are in the office: the employee gets them with the task, not after.
        released: released && files.length === 0,
        ...(requiresReview === null ? {} : { requiresReview }),
      }),
    );
    if (created && files.length) {
      for (const f of files) await run(() => uploadFile(created.id, f));
      if (released) await run(() => api('POST', '/tasks/release', { ids: [created.id] }));
    }
    if (created) {
      s.toast(`${created.key} created`, 'success');
      s.openPanel('task', created.id);
    }
  };

  return (
    <Window title="New task" subtitle={preset ? `For ${preset.name} · ${preset.title}` : 'Given to an employee; done when the project\'s check passes'} onClose={onClose} width={720}>
      {projects.length === 0 ? (
        <Empty title="No projects yet">
          A task needs a project.{' '}
          <button type="button" className="pw-chip" onClick={() => s.openPanel('projects')}>
            Create a project
          </button>
        </Empty>
      ) : (
        <form className="pw-form" onSubmit={submit}>
          <Field label="Project">
            <select
              value={projectId}
              required
              onChange={(e) => {
                setProjectId(e.target.value);
                setDependsOn([]);
              }}
            >
              <option value="" disabled>
                Choose a project…
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.status === 'paused' ? ' (paused)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assignee" hint={assigneeId ? undefined : 'The scheduler picks a free employee with a matching role.'}>
            <select
              value={assigneeId}
              onChange={(e) => {
                setAssigneeId(e.target.value);
                // Choosing a person with no project chosen yet means "their project".
                const theirs = s.employees[e.target.value]?.projectId;
                if (!projectId && theirs && projects.some((p) => p.id === theirs)) setProjectId(theirs);
              }}
            >
              <option value="">Unassigned (route by role)</option>
              {activeEmployees(s.employees).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title" wide>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to be done" autoFocus required />
          </Field>
          <Field label="Description" wide>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Context, constraints, where to look. This goes into the prompt as written." />
          </Field>
          <div className="field-wide">
            <PendingFiles files={files} onChange={setFiles} />
          </div>
          {/* What most tasks leave as it is stays folded away; the line says what it holds. */}
          <details className="pc-more field-wide" open={more} onToggle={(ev) => setMore((ev.currentTarget as HTMLDetailsElement).open)}>
            <summary>
              More options: how to tell it is done, kind, priority, dependencies, review
              {!more && changed.length > 0 && <span className="small faint"> — {changed.join(' · ')}</span>}
            </summary>
            <div className="pw-form" style={{ marginTop: 10 }}>
              <Field label="Acceptance criteria" wide>
                <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder="How to tell it is done." style={{ minHeight: 56 }} />
              </Field>
              <Field label="Kind">
                <select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
                  {CREATABLE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Priority">
                <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
              {!assigneeId && (
                <Field label="Role hint" wide>
                  <select value={roleHint} onChange={(e) => setRoleHint(e.target.value)}>
                    <option value="">Any role that handles this kind of task</option>
                    {ROLE_CATALOGUE.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.title}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <div className="field field-wide">
                <span className="field-label">Depends on{dependsOn.length ? ` (${dependsOn.length})` : ''}</span>
                {candidates.length === 0 ? (
                  <span className="field-hint">{projectId ? 'This project has no other tasks yet.' : 'Choose a project to pick dependencies.'}</span>
                ) : (
                  <div className="pw-picklist">
                    {candidates.map((t) => (
                      <label key={t.id} className="check small">
                        <input type="checkbox" checked={dependsOn.includes(t.id)} onChange={(e) => setDependsOn(e.target.checked ? [...dependsOn, t.id] : dependsOn.filter((d) => d !== t.id))} />
                        <span className="mono muted">{t.key}</span>
                        <span className="grow truncate">{t.title}</span>
                        <Badge tone={STATUS_META[t.status].tone}>{STATUS_META[t.status].label}</Badge>
                      </label>
                    ))}
                  </div>
                )}
                <span className="field-hint">The task becomes READY only when all of these are DONE.</span>
              </div>
              <label className="check">
                <input type="checkbox" checked={requiresReview ?? reviewDefault} onChange={(e) => setRequiresReview(e.target.checked)} />
                <span>
                  Requires review
                  <br />
                  <span className="field-hint">{requiresReview === null ? `Following the project policy (${reviewDefault ? 'on' : 'off'} for this kind).` : 'Set by you for this task.'}</span>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={released} onChange={(e) => setReleased(e.target.checked)} />
                <span>
                  Release immediately
                  <br />
                  <span className="field-hint">{released ? 'Scheduled as soon as its dependencies are done.' : 'Stays in the backlog as proposed until you release it.'}</span>
                </span>
              </label>
            </div>
          </details>
          <div className="row field-wide">
            <Button variant="primary" type="submit" disabled={busy || !projectId || !title.trim()}>
              Create task
            </Button>
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Window>
  );
}

// ─────────────────────────── task: overview ──────────────────────────

const DELIVERY_TONE: Record<DeliveryState['status'], Tone> = { none: 'muted', queued: 'neutral', sent: 'info', confirmed: 'good', failed: 'bad' };

function Delivery({ delivery }: { delivery: DeliveryState }) {
  return (
    <div className="col" style={{ gap: 3 }}>
      <span className="row row-wrap" style={{ gap: 6 }}>
        <Badge tone={DELIVERY_TONE[delivery.status]} title="queued → sent (written into the session) → confirmed (a real hook from Claude Code acknowledged it)">
          {delivery.status}
        </Badge>
        {delivery.via && <span className="small muted">via {delivery.via.replace(/_/g, ' ')}</span>}
        {delivery.ts && <span className="small faint">{timeAgo(delivery.ts)}</span>}
      </span>
      {delivery.detail && <span className="small muted">{delivery.detail}</span>}
    </div>
  );
}

function TaskOverview({ task, onClose, onShowChanges }: { task: Task; onClose: () => void; onShowChanges: () => void }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const [note, setNote] = useState('');
  const project = s.projects[task.projectId];
  const assignee = task.assigneeId ? s.employees[task.assigneeId] : undefined;
  // A finished task keeps the assignee it was done by: the track record is counted from it.
  const editable = task.status !== 'IN_PROGRESS' && task.status !== 'DONE';
  const mergeFailed = !!task.evidence.merge && !task.evidence.merge.ok;
  const patch = (body: Record<string, unknown>, ok: string) => run(() => api('PATCH', `/tasks/${task.id}`, body), ok);
  const review = async (verdict: 'approve' | 'request_changes') => {
    const res = await run(() => api('POST', `/tasks/${task.id}/review`, { verdict, comments: note }), verdict === 'approve' ? `${task.key} approved` : `Changes requested on ${task.key}`);
    if (res) setNote('');
  };
  const remove = async () => {
    if (!(await ask({ title: `Delete ${task.key}?`, body: `"${task.title}"\n\nThe task and its record are removed from the board. This cannot be undone. Its branch and folder on the machine are left as they are.`, ok: 'Delete task', danger: true }))) return;
    const res = await run(() => api('DELETE', `/tasks/${task.id}`), `${task.key} deleted`);
    if (res) s.openPanel('tasks');
  };

  return (
    <div className="pw-cols">
      <div className="col" style={{ gap: 12 }}>
        <div className="row row-wrap">
          <Badge tone={STATUS_META[task.status].tone}>{STATUS_META[task.status].label}</Badge>
          <Badge tone="muted">{task.kind}</Badge>
          <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority} priority</Badge>
          {!task.released && <Badge tone="warn">proposed — not released</Badge>}
          {task.requiresReview && <Badge tone="neutral">requires review</Badge>}
          {task.attempts > 0 && <span className="small muted">sent back {task.attempts}×</span>}
        </div>

        {!task.released && (
          <div className="card row spread">
            <span className="small">Proposed: nobody starts it until you release it.</span>
            <Button variant="success" disabled={busy} onClick={() => run(() => api('POST', '/tasks/release', { ids: [task.id] }), `${task.key} released for scheduling`)}>
              Release
            </Button>
          </div>
        )}

        <TaskFiles task={task} />

        {task.status === 'IN_PROGRESS' && <StepIn task={task} assignee={assignee?.name ?? null} />}

        {task.status === 'BLOCKED' && (
          <div className="card col">
            <div className="section-title">Blocked</div>
            <div className="pre">{task.blockedReason ?? 'No reason was recorded.'}</div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the employee: what changed and what to do now." />
            <div className="row row-wrap">
              <Button variant="success" disabled={busy} onClick={() => run(() => api('POST', `/tasks/${task.id}/unblock`, { note }), `${task.key} unblocked`).then((r) => r && setNote(''))}>
                Unblock
              </Button>
              {mergeFailed && (
                <Button disabled={busy} onClick={() => run(() => api('POST', `/tasks/${task.id}/retry-merge`, {}), `Merge of ${task.key} retried`)} title="Use this after resolving the conflict by hand in the worktree">
                  Retry merge
                </Button>
              )}
            </div>
            <div className="small faint">
              Unblocking sends the task back to the employee together with your note.
              {mergeFailed && ' Retry merge runs the merge again after you resolved the conflict by hand; the result appears under Evidence.'}
            </div>
          </div>
        )}

        {task.status === 'REVIEW' && (
          <div className="card col">
            <div className="section-title">Your review</div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Comments. Required when you request changes: they are sent to the employee." />
            <div className="row row-wrap">
              <Button variant="success" disabled={busy} onClick={() => review('approve')}>
                Approve
              </Button>
              <Button variant="danger" disabled={busy || !note.trim()} onClick={() => review('request_changes')}>
                Request changes
              </Button>
              <Button variant="ghost" onClick={onShowChanges}>
                Look at the changes first
              </Button>
            </div>
            <div className="small faint">Approve to let it finish (merge included), or send it back with what should change.</div>
          </div>
        )}

        <div>
          <div className="section-title">Description</div>
          {task.description ? <Markdown text={task.description} /> : <div className="muted">No description.</div>}
        </div>
        <div>
          <div className="section-title">Acceptance criteria</div>
          {task.acceptance ? <div className="pre">{task.acceptance}</div> : <div className="muted">None given.</div>}
        </div>
        <div>
          <div className="section-title">
            Progress <span style={{ textTransform: 'none', letterSpacing: 0 }}>— reported by the employee</span>
          </div>
          {task.progress.percent == null && !task.progress.note ? (
            <div className="muted">Not available: the employee has not reported progress.</div>
          ) : (
            <div className="col" style={{ gap: 4 }}>
              {task.progress.percent != null && (
                <div className="row">
                  <Progress value={task.progress.percent} />
                  <span className="small mono">{Math.round(task.progress.percent)}%</span>
                </div>
              )}
              {task.progress.note && <div className="small pre">{task.progress.note}</div>}
              {task.progress.ts && <div className="small faint">reported {timeAgo(task.progress.ts)}</div>}
            </div>
          )}
        </div>

        <div className="row row-wrap" style={{ marginTop: 6 }}>
          <select
            className="pw-inline-select"
            aria-label="Move to another column"
            value=""
            onChange={(e) => {
              if (e.target.value) moveTask(task.id, e.target.value as TaskStatus);
            }}
          >
            <option value="">Move to…</option>
            {TASK_STATUSES.filter((st) => st !== task.status && st !== 'IN_PROGRESS').map((st) => (
              <option key={st} value={st}>
                {STATUS_META[st].label}
                {st === 'DONE' ? ' (by hand, unverified)' : ''}
              </option>
            ))}
          </select>
          <div className="grow" />
          {task.status !== 'IN_PROGRESS' && (
            <Button variant="danger" small disabled={busy} onClick={remove}>
              Delete task
            </Button>
          )}
        </div>
      </div>

      <dl className="kv small">
        <dt>Project</dt>
        <dd>
          {project ? (
            <button type="button" className="pw-chip" onClick={() => s.openPanel('projects', project.id)}>
              <span className="dot" style={{ background: project.color }} />
              <span className="truncate">{project.name}</span>
            </button>
          ) : (
            <span className="muted">unknown project</span>
          )}
        </dd>
        <dt>Assignee</dt>
        <dd className="col" style={{ gap: 6 }}>
          {editable ? (
            <select aria-label="Assignee" value={task.assigneeId ?? ''} disabled={busy} onChange={(e) => patch({ assigneeId: e.target.value || null }, e.target.value ? `${task.key} assigned to ${s.employees[e.target.value]?.name ?? 'employee'}` : `${task.key} unassigned`)}>
              <option value="">Unassigned (route by role)</option>
              {activeEmployees(s.employees).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.title}
                </option>
              ))}
            </select>
          ) : (
            <Person id={task.assigneeId} />
          )}
          {assignee && (
            <span>
              <Button
                small
                onClick={() => {
                  s.focusEmployee(assignee.id);
                  onClose();
                }}
              >
                Go to desk
              </Button>
            </span>
          )}
        </dd>
        {!task.assigneeId && (
          <>
            <dt>Role hint</dt>
            <dd>{task.roleHint ?? <span className="muted">any</span>}</dd>
          </>
        )}
        <dt>Priority</dt>
        <dd>
          {editable ? (
            <select aria-label="Priority" value={task.priority} disabled={busy} onChange={(e) => patch({ priority: e.target.value }, `${task.key} priority set to ${e.target.value}`)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          ) : (
            task.priority
          )}
        </dd>
        {task.reviewerId && (
          <>
            <dt>Reviewer</dt>
            <dd>
              <Person id={task.reviewerId} fallback="unknown" />
            </dd>
          </>
        )}
        {task.reviewOf && (
          <>
            <dt>Review of</dt>
            <dd>
              <TaskChip id={task.reviewOf} />
            </dd>
          </>
        )}
        <dt>Depends on</dt>
        <dd className="row row-wrap" style={{ gap: 4 }}>
          {task.dependsOn.length ? task.dependsOn.map((id) => <TaskChip key={id} id={id} />) : <span className="muted">nothing</span>}
        </dd>
        <dt>Branch</dt>
        <dd className="mono">{task.branch ?? <span className="muted">not created yet</span>}</dd>
        <dt>Worktree</dt>
        <dd className="mono">{task.worktree ?? <span className="muted">not created yet</span>}</dd>
        {task.baseSha && (
          <>
            <dt>Base commit</dt>
            <dd className="mono">{task.baseSha.slice(0, 10)}</dd>
          </>
        )}
        <dt>Prompt delivery</dt>
        <dd>
          <Delivery delivery={task.delivery} />
        </dd>
        <dt>Created</dt>
        <dd>
          {stamp(task.createdAt)} by {task.createdBy}
        </dd>
        <dt>Started</dt>
        <dd>{task.startedAt ? stamp(task.startedAt) : <span className="muted">not yet</span>}</dd>
        <dt>Completed</dt>
        <dd>{task.completedAt ? stamp(task.completedAt) : <span className="muted">not yet</span>}</dd>
      </dl>
    </div>
  );
}

// ─────────────────────────── task: evidence ──────────────────────────

/**
 * Stepping into a task somebody is working on: correct it (they are told at once and go on), put it on hold, or
 * stop and remove it. Each really reaches the employee's session — a correction as a message, a stop as an interrupt.
 */
function StepIn({ task, assignee }: { task: Task; assignee: string | null }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const [note, setNote] = useState('');
  const [now, setNow] = useState(true);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [acceptance, setAcceptance] = useState(task.acceptance);
  const who = assignee ?? 'the employee';
  const textChanged = editing && (title.trim() !== task.title.trim() || description.trim() !== task.description.trim() || acceptance.trim() !== task.acceptance.trim());
  const correct = async () => {
    const res = await run(() => api('POST', `/tasks/${task.id}/correct`, { note, now, ...(editing ? { title, description, acceptance } : {}) }), `${who} was told`);
    if (res) {
      setNote('');
      setEditing(false);
    }
  };
  const hold = async () => {
    const res = await run(() => api('POST', `/tasks/${task.id}/stop`, { then: 'hold', note }), `${task.key} stopped and put on hold`);
    if (res) setNote('');
  };
  const remove = async () => {
    if (!(await ask({ title: `Stop and delete ${task.key}?`, body: `"${task.title}"\n\n${who} is interrupted and told to leave it; the task and its record are removed from the board. This cannot be undone. What was already committed stays on its branch on the machine.`, ok: 'Stop and delete' }))) return;
    const res = await run(() => api('POST', `/tasks/${task.id}/stop`, { then: 'delete', note }), `${task.key} stopped and deleted`);
    if (res) s.openPanel('tasks');
  };
  return (
    <div className="card col" data-step-in>
      <div className="section-title">Step in</div>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={`What ${who} should do differently — or why you are stopping it. Sent to ${who} as written.`} aria-label="Correction or reason" />
      {editing && (
        <div className="col" style={{ gap: 6 }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" aria-label="Description" style={{ minHeight: 90 }} />
          <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder="Acceptance criteria" aria-label="Acceptance criteria" />
        </div>
      )}
      <div className="row row-wrap">
        <Button variant="primary" disabled={busy || (!note.trim() && !textChanged)} onClick={correct} title={`${who} gets the correction and goes on with the task`}>
          Send correction
        </Button>
        <label className="check small" title="On: their current turn is interrupted (Escape in their terminal) and the correction is the next thing they read. Off: they read it when the turn ends.">
          <input type="checkbox" checked={now} onChange={(e) => setNow(e.target.checked)} /> <span>interrupt now</span>
        </label>
        {!editing && (
          <Button variant="ghost" small onClick={() => setEditing(true)}>
            Change the task's text…
          </Button>
        )}
        <div className="grow" />
        <Button disabled={busy} onClick={hold} title={`${who} is interrupted and told to leave it. The task waits in the backlog, with its branch, until you release it again.`}>
          Stop — put on hold
        </Button>
        <Button variant="danger" disabled={busy} onClick={remove}>
          Stop and delete…
        </Button>
      </div>
      <div className="small faint">
        A correction changes the task and tells {who}; they go on with it. Stopping interrupts them in their terminal and frees them for other work{note.trim() ? '; what you wrote above is given as the reason' : ''}.
      </div>
    </div>
  );
}

function Section({ title, provenance, children }: { title: string; provenance?: EvidenceProvenance; children: ReactNode }) {
  return (
    <div>
      <div className="section-title row" style={{ gap: 8 }}>
        {title}
        {provenance && <Provenance kind={provenance} />}
      </div>
      {children}
    </div>
  );
}

function TaskEvidence({ task }: { task: Task }) {
  const ev = task.evidence;
  const v = ev.verification;
  const f = task.friction;
  return (
    <div className="col" style={{ gap: 4 }}>
      <TaskFiles task={task} only="evidence" />
      <Section title="Verification" provenance={v?.provenance}>
        {v ? (
          <div className="col">
            <div className="row row-wrap">
              <Badge tone={v.passed === true ? 'good' : v.passed === false ? 'bad' : 'muted'}>{v.passed === true ? 'passed' : v.passed === false ? 'failed' : 'no result'}</Badge>
              <span className="small muted">
                exit code {v.exitCode ?? 'not available'} · duration {v.durationMs != null ? formatDuration(v.durationMs) : 'not available'} · {stamp(v.ts)}
              </span>
            </div>
            {v.command ? <div className="code">$ {v.command}</div> : <div className="small muted">No verification command is configured, so nothing was run.</div>}
            {v.outputTail && (
              <>
                <div className="small faint">End of the command's output, as captured on the host:</div>
                <div className="code">{v.outputTail}</div>
              </>
            )}
          </div>
        ) : (
          <div className="muted">No verification is on record for this task. History shows how it reached its current status.</div>
        )}
      </Section>

      <Section title="What the employee reported" provenance="reported">
        {ev.summary ? <Markdown text={ev.summary} /> : <div className="muted">Not available: the employee has not submitted a result.</div>}
        {ev.reportedTests && (
          <div style={{ marginTop: 8 }}>
            <div className="small faint">Tests, as described by the employee:</div>
            <div className="small pre">{ev.reportedTests}</div>
          </div>
        )}
      </Section>

      <Section title={`Commits (${ev.commits.length})`} provenance="measured">
        {ev.commits.length ? (
          <table className="tbl">
            <tbody>
              {ev.commits.map((c) => (
                <tr key={c.sha}>
                  <td className="mono">{c.sha.slice(0, 8)}</td>
                  <td>{c.subject}</td>
                  <td className="small muted">{c.author}</td>
                  <td className="small faint">{c.ts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">No commits have been recorded on the task branch.</div>
        )}
      </Section>

      {ev.verification?.touchedChecks?.length ? (
        <div className="pc-note" data-touched-checks>
          This task changed what it is checked by — {ev.verification.touchedChecks.slice(0, 8).join(', ')}
          {ev.verification.touchedChecks.length > 8 ? ` and ${ev.verification.touchedChecks.length - 8} more` : ''}. Its checks passed with those changes, so it was sent to review: look at what was changed in the tests before approving.
        </div>
      ) : null}
      <Section title={`Files changed (${ev.filesChanged.length})`} provenance="measured">
        {ev.filesChanged.length ? <div className="code">{ev.filesChanged.join('\n')}</div> : <div className="muted">None recorded.</div>}
        {ev.diffStat && (
          <div className="code" style={{ marginTop: 8 }}>
            {ev.diffStat}
          </div>
        )}
      </Section>

      <Section title="Review">
        {ev.review ? (
          <div className="col" style={{ gap: 6 }}>
            <div className="row row-wrap">
              <Badge tone={ev.review.verdict === 'approved' ? 'good' : 'warn'}>{ev.review.verdict === 'approved' ? 'approved' : 'changes requested'}</Badge>
              <span className="small muted row" style={{ gap: 6 }}>
                by {ev.review.by === 'owner' ? 'you' : <Person id={ev.review.reviewerId} size={18} fallback="an employee" />} · {stamp(ev.review.ts)}
              </span>
            </div>
            {ev.review.comments ? <Markdown text={ev.review.comments} /> : <div className="small muted">No comments.</div>}
          </div>
        ) : (
          <div className="muted">{task.requiresReview ? 'Required, not reviewed yet.' : 'Not required for this task; none recorded.'}</div>
        )}
      </Section>

      <Section title="Merge" provenance={ev.merge ? 'measured' : undefined}>
        {ev.merge ? (
          <div className="col" style={{ gap: 6 }}>
            <div className="row row-wrap">
              <Badge tone={ev.merge.ok ? 'good' : 'bad'}>{ev.merge.ok ? 'merged' : 'merge failed'}</Badge>
              <span className="small muted">
                into <span className="mono">{ev.merge.into}</span>
                {ev.merge.sha ? (
                  <>
                    {' '}
                    at <span className="mono">{ev.merge.sha.slice(0, 8)}</span>
                  </>
                ) : null}{' '}
                · {stamp(ev.merge.ts)}
              </span>
            </div>
            {ev.merge.detail && <div className="code">{ev.merge.detail}</div>}
          </div>
        ) : (
          <div className="muted">No merge has been attempted.</div>
        )}
      </Section>

      <Section title="Friction on the way" provenance="measured">
        <div className="grid4">
          <Stat label="Failed verifications" value={f.failedVerifications} tone={f.failedVerifications ? 'warn' : undefined} />
          <Stat label="Review rejections" value={f.reviewRejections} tone={f.reviewRejections ? 'warn' : undefined} />
          <Stat label="Merge conflicts" value={f.mergeConflicts} tone={f.mergeConflicts ? 'warn' : undefined} />
          <Stat label="Blockers" value={f.blockers} tone={f.blockers ? 'warn' : undefined} />
          <Stat label="Questions asked" value={f.questions} />
          <Stat label="Permission denials" value={f.denials} />
          <Stat label="Nudges to continue" value={task.nudges} />
          <Stat label="Times sent back" value={task.attempts} />
        </div>
      </Section>
    </div>
  );
}

// ─────────────────────────── task: changes ───────────────────────────

/** What the host returns for a working tree (git status + diff, read live). */
interface GitView {
  cwd: string;
  base: string | null;
  status: { branch: string | null; head: string | null; dirty: boolean; files: Array<{ status: string; path: string }>; repoRoot: string | null };
  diff: { stat: string; diff: string; truncated: boolean; uncommitted: string; untracked: string[]; files: string[] };
}

function DiffView({ text }: { text: string }) {
  const lines = useMemo(() => {
    let header = false;
    return text
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => {
        if (line.startsWith('diff --git')) header = true;
        else if (line.startsWith('@@')) header = false;
        const cls = header ? 'diff-file' : line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : undefined;
        return { line, cls };
      });
  }, [text]);
  return (
    <div className="code pw-diff">
      {lines.map((l, i) => (
        <div key={i} className={l.cls}>
          {l.line}
        </div>
      ))}
    </div>
  );
}

function GitChanges({ path }: { path: string }) {
  const q = useQuery({ queryKey: ['git-view', path], queryFn: () => api<GitView>('GET', path), retry: false, refetchOnMount: 'always' });
  if (q.isPending) return <div className="muted">Reading the working tree from the host…</div>;
  if (q.isError) {
    return (
      <div className="col" style={{ alignItems: 'center' }}>
        <Empty title="The changes cannot be read right now">
          Orchestrator reads them live from the employee's machine, and it answered: {q.error.message}.
        </Empty>
        <Button onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? 'Trying…' : 'Try again'}
        </Button>
      </div>
    );
  }
  const { cwd, base, status, diff } = q.data;
  const tracked = status.files.filter((f) => f.status !== '??');
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row spread">
        <span className="row" style={{ gap: 8 }}>
          <Provenance kind="measured" />
          <span className="small muted">read from the host at {clock(new Date(q.dataUpdatedAt).toISOString())}</span>
        </span>
        <Button small onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      <dl className="kv small">
        <dt>Working directory</dt>
        <dd className="mono">{cwd}</dd>
        <dt>Branch</dt>
        <dd className="mono">
          {status.branch ?? 'not available'}
          {status.head ? ` @ ${status.head.slice(0, 10)}` : ''}
        </dd>
        <dt>Compared with</dt>
        <dd className="mono">{base ?? <span className="muted">no base is known — only uncommitted changes can be shown</span>}</dd>
      </dl>
      {!status.repoRoot ? (
        <Empty title="Not a git repository">This directory is not under git, so there is nothing to diff.</Empty>
      ) : (
        <>
          {diff.truncated && <div className="pw-note pw-warn">The diff is larger than 300 KB and was cut off on the host. What follows is incomplete; open the workstation to see everything.</div>}

          <div className="section-title">Committed since the base{diff.files.length ? ` (${plural(diff.files.length, 'file')})` : ''}</div>
          {diff.stat && <div className="code">{diff.stat}</div>}
          {diff.diff ? <DiffView text={diff.diff} /> : <div className="muted">{base ? 'No committed changes.' : 'Not available without a base.'}</div>}

          <div className="section-title">Uncommitted changes{tracked.length ? ` (${plural(tracked.length, 'file')})` : ''}</div>
          {tracked.length > 0 && <div className="code">{tracked.map((f) => `${f.status.padEnd(2)} ${f.path}`).join('\n')}</div>}
          {diff.uncommitted ? <DiffView text={diff.uncommitted} /> : <div className="muted">{status.dirty ? 'No changes to tracked files.' : 'The working tree is clean.'}</div>}

          <div className="section-title">Untracked files ({diff.untracked.length})</div>
          {diff.untracked.length ? <div className="code">{diff.untracked.join('\n')}</div> : <div className="muted">None.</div>}
        </>
      )}
    </div>
  );
}

// ─────────────────────────── task: history ───────────────────────────

interface HistoryRow {
  key: string;
  ts: string;
  seq: number;
  origin: string;
  text: string;
  detail: string;
}

function TaskHistory({ task }: { task: Task }) {
  const q = useQuery({ queryKey: ['task-events', task.id], queryFn: () => api<OrchestratorEvent[]>('GET', `/events?taskId=${encodeURIComponent(task.id)}&limit=300`), refetchOnMount: 'always' });
  const live = useOffice((s) => s.events);
  const rows = useMemo(() => {
    const events = new Map<string, OrchestratorEvent>();
    for (const e of q.data ?? []) events.set(e.id, e);
    for (const e of live) if (e.taskId === task.id && e.type !== 'session.activity') events.set(e.id, e);
    const out: HistoryRow[] = [...events.values()].map((e) => ({ key: e.id, ts: e.ts, seq: e.seq, origin: e.source.kind, text: e.summary, detail: e.type }));
    task.history.forEach((h, i) => out.push({ key: `h${i}`, ts: h.ts, seq: i, origin: 'board', text: h.note, detail: `${STATUS_META[h.status].label} · by ${h.by}` }));
    return out.sort((a, b) => b.ts.localeCompare(a.ts) || b.seq - a.seq);
  }, [q.data, live, task.history, task.id]);
  return (
    <div className="col">
      <div className="small muted">
        Newest first. <Badge tone="accent">board</Badge> rows are the task's own status record; the others are recorded events, labelled with the signal they came from (hook, mcp, host, server, owner).
      </div>
      {q.isError && <div className="pw-note pw-warn">The stored event log could not be loaded ({q.error.message}). Showing the task's own record and the events received in this session.</div>}
      {q.data?.length === 300 && <div className="pw-note">Only the latest 300 stored events are shown.</div>}
      {rows.length === 0 ? (
        <div className="muted">{q.isPending ? 'Loading…' : 'Nothing has been recorded for this task yet.'}</div>
      ) : (
        <div className="pw-timeline">
          {rows.map((r) => (
            <div key={r.key} style={{ display: 'contents' }}>
              <span className="mono faint" title={new Date(r.ts).toLocaleString()}>
                {stamp(r.ts)}
              </span>
              <Badge tone={r.origin === 'board' ? 'accent' : 'muted'}>{r.origin}</Badge>
              <span>
                {r.text} <span className="small faint">{r.detail}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── task panel ────────────────────────────

type TaskTab = 'overview' | 'evidence' | 'changes' | 'history';

function TaskDetail({ id, initialTab, onClose }: { id: string; initialTab: TaskTab; onClose: () => void }) {
  const task = useOffice((s) => s.tasks[id]);
  const project = useOffice((s) => (task ? s.projects[task.projectId] : undefined));
  const [tab, setTab] = useState<TaskTab>(initialTab);
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
      width={1040}
      flush
      actions={
        <Button small variant="ghost" onClick={() => useOffice.getState().openPanel('tasks')}>
          All tasks
        </Button>
      }
    >
      <div className="pw-frame">
        <Tabs<TaskTab>
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'evidence', label: 'Evidence' },
            { id: 'changes', label: 'Changes' },
            { id: 'history', label: 'History' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="pw-body">
          {tab === 'overview' && <TaskOverview task={task} onClose={onClose} onShowChanges={() => setTab('changes')} />}
          {tab === 'evidence' && <TaskEvidence task={task} />}
          {tab === 'changes' && <GitChanges path={`/tasks/${task.id}/git`} />}
          {tab === 'history' && <TaskHistory task={task} />}
        </div>
      </div>
    </Window>
  );
}

function EmployeeChanges({ employeeId, onClose }: { employeeId: string; onClose: () => void }) {
  const e = useOffice((s) => s.employees[employeeId]);
  return (
    <Window title={e ? `${e.name}'s working tree` : 'Working tree'} subtitle="What they have changed in their folder so far" onClose={onClose} width={1040} flush>
      <div className="pw-frame">
        <div className="pw-body">{e ? <GitChanges path={`/employees/${employeeId}/git`} /> : <Empty title="Unknown employee" />}</div>
      </div>
    </Window>
  );
}

/** arg: `<taskId>` · `<taskId>:diff` · `new` · `new:<employeeId>` · `diff:<employeeId>` */
function TaskPanel({ arg, onClose }: PanelProps) {
  if (!arg) return null;
  const [head, rest] = arg.split(':') as [string, string | undefined];
  if (head === 'new') return <TaskCreate key={arg} employeeId={rest ?? null} onClose={onClose} />;
  if (head === 'diff' && rest) return <EmployeeChanges key={arg} employeeId={rest} onClose={onClose} />;
  return <TaskDetail key={arg} id={head} initialTab={rest === 'diff' ? 'changes' : 'overview'} onClose={onClose} />;
}

registerPanel('tasks', TasksPanel);
registerPanel('task', TaskPanel);
