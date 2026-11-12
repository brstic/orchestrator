import { useState, type FormEvent } from 'react';
import type { ReviewBy, Task, TaskKind, TaskPriority } from '@orchestrator/contracts';
import { ROLE_CATALOGUE, reviewDefaultOf } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Field } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { PendingFiles, uploadFile } from './task-files.tsx';
import { REVIEW_CHOICES, STATUS_META, activeEmployees, useAction } from './task-shared.tsx';

/** Review tasks are created by Orchestrator for a specific task under review, never by hand. */
const CREATABLE_KINDS: TaskKind[] = ['feature', 'bug', 'test', 'research', 'planning', 'security', 'docs', 'ops', 'refactor', 'chore'];
const PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal', 'low'];

/**
 * A new ticket, written in the place where it will then be read: what to do, who does it (and who with), and who
 * looks at it when it is done. Everything else is folded away, and what was changed in there is said on the fold.
 */
export function TicketNew({ employeeId, onCreated, onCancel }: { employeeId: string | null; onCreated: (task: Task) => void; onCancel: () => void }) {
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
  const [helperIds, setHelperIds] = useState<string[]>([]);
  const [roleHint, setRoleHint] = useState('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const usual = reviewDefaultOf(s.settings);
  const [reviewBy, setReviewBy] = useState<ReviewBy>(usual);
  const [released, setReleased] = useState(true);
  const [more, setMore] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  const everyone = activeEmployees(s.employees).filter((e) => e.roleKey !== 'foreman');
  const candidates = Object.values(s.tasks)
    .filter((t) => t.projectId === projectId && t.kind !== 'review')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  /** What differs from the usual inside the folded part, so nothing set there goes unseen. */
  const changed = [acceptance.trim() ? 'acceptance criteria' : '', kind !== 'feature' ? kind : '', priority !== 'normal' ? `${priority} priority` : '', dependsOn.length ? `depends on ${dependsOn.length}` : '', released ? '' : 'kept as proposed'].filter(Boolean);

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
        helperIds: assigneeId ? helperIds.filter((id) => id !== assigneeId) : [],
        roleHint: assigneeId ? null : roleHint || null,
        dependsOn,
        reviewBy,
        // With files, the ticket is held until they are in the office: the employee gets them with it, not after.
        released: released && files.length === 0,
      }),
    );
    if (created && files.length) {
      for (const f of files) await run(() => uploadFile(created.id, f));
      if (released) await run(() => api('POST', '/tasks/release', { ids: [created.id] }));
    }
    if (created) {
      s.toast(`${created.key} created`, 'success');
      onCreated(created);
    }
  };

  if (projects.length === 0) {
    return (
      <div className="tk-pane tk-pane-pad">
        <Empty title="No projects yet">
          A ticket belongs to a project.{' '}
          <button type="button" className="pw-chip" onClick={() => s.openPanel('projects')}>
            Create a project
          </button>
        </Empty>
      </div>
    );
  }
  return (
    <form className="tk-pane tk-new" onSubmit={submit} data-ticket-new>
      <div className="tk-new-scroll">
        <div className="tk-new-head">
          <div className="tk-eyebrow">New ticket{preset ? ` for ${preset.name}` : ''}</div>
          <input className="tk-title-input" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to be done" autoFocus required />
        </div>
        <Field label="Description" wide>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Context, constraints, where to look. This goes to the employee as written." style={{ minHeight: 130 }} />
        </Field>
        <PendingFiles files={files} onChange={setFiles} />
        <div className="tk-new-grid">
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
          <Field label="Assignee" hint={assigneeId ? undefined : 'Whoever fits and is free takes it.'}>
            <select
              value={assigneeId}
              onChange={(e) => {
                setAssigneeId(e.target.value);
                setHelperIds((list) => list.filter((id) => id !== e.target.value));
                // Choosing a person with no project chosen yet means "their project".
                const theirs = s.employees[e.target.value]?.projectId;
                if (!projectId && theirs && projects.some((p) => p.id === theirs)) setProjectId(theirs);
              }}
            >
              <option value="">Unassigned (route by role)</option>
              {everyone.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {assigneeId && (
          <div className="field">
            <span className="field-label">Working on it with {s.employees[assigneeId]?.name ?? 'them'}</span>
            <div className="tk-people-pick" role="group" aria-label="Also on this ticket">
              {everyone
                .filter((e) => e.id !== assigneeId)
                .map((e) => {
                  const on = helperIds.includes(e.id);
                  return (
                    <button key={e.id} type="button" className={`tk-person-chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setHelperIds(on ? helperIds.filter((id) => id !== e.id) : [...helperIds, e.id])} title={e.title}>
                      <Avatar appearance={e.appearance} size={18} />
                      {e.name}
                    </button>
                  );
                })}
            </div>
            <span className="field-hint">{helperIds.length ? `${s.employees[assigneeId]?.name ?? 'The assignee'} leads it and divides the work between them.` : 'Nobody: one employee does it. Pick colleagues for a ticket that is too much for one.'}</span>
          </div>
        )}
        <div className="field">
          <span className="field-label">When it is finished, it is reviewed by</span>
          <div className="tk-seg" role="radiogroup" aria-label="Review">
            {REVIEW_CHOICES.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={reviewBy === c.id} className={reviewBy === c.id ? 'on' : ''} onClick={() => setReviewBy(c.id)} data-review={c.id}>
                {c.label}
              </button>
            ))}
          </div>
          <span className="field-hint">{REVIEW_CHOICES.find((c) => c.id === reviewBy)!.hint}</span>
        </div>
        {/* What most tickets leave as it is stays folded away; the line says what it holds. */}
        <details className="pc-more" open={more} onToggle={(ev) => setMore((ev.currentTarget as HTMLDetailsElement).open)}>
          <summary>
            More options: how to tell it is done, kind, priority, what it waits for
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
                  <option value="">Any role that handles this kind of work</option>
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
                <span className="field-hint">{projectId ? 'This project has no other tickets yet.' : 'Choose a project to pick what it depends on.'}</span>
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
              <span className="field-hint">It starts only when all of these are done.</span>
            </div>
            <label className="check field-wide">
              <input type="checkbox" checked={released} onChange={(e) => setReleased(e.target.checked)} />
              <span>
                Start as soon as somebody is free
                <br />
                <span className="field-hint">{released ? 'Handed over when its assignee is free and what it depends on is done.' : 'Kept as proposed until you release it.'}</span>
              </span>
            </label>
          </div>
        </details>
      </div>
      <div className="tk-new-foot">
        <Button variant="primary" type="submit" disabled={busy || !projectId || !title.trim()}>
          Create ticket
        </Button>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        {reviewBy !== usual && <span className="small faint">Reviewed differently from the office's usual ({REVIEW_CHOICES.find((c) => c.id === usual)!.label.toLowerCase()}).</span>}
      </div>
    </form>
  );
}
