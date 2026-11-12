import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Employee, ReviewBy, Task, TaskComment, TaskPriority, TaskStatus } from '@orchestrator/contracts';
import { reviewByOf } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Markdown, Progress, Tabs, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useAccess } from '../../lib/access.ts';
import { useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';
import { TaskFiles } from './task-files.tsx';
import { REVIEW_CHOICES, STATUS_META, TASK_STATUSES, activeEmployees, needOf, openQuestionOf, stamp, useAction } from './task-shared.tsx';
import { Delivery, GitChanges, TaskEvidence, TaskHistory } from './task-work.tsx';

export type TicketTab = 'talk' | 'work' | 'changes' | 'history';

const PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal', 'low'];

/** A manual move. The office decides what is legal; marking DONE by hand is spelled out first. */
async function moveTask(task: Task, status: TaskStatus): Promise<void> {
  if (task.status === status) return;
  if (status === 'DONE' && !(await ask({ title: `Mark ${task.key} as done by hand?`, body: 'Nobody will have checked it. The record will say it was marked done by hand, not verified.', ok: 'Mark as done' }))) return;
  void act(() => api('PATCH', `/tasks/${task.id}`, { status }), `${task.key} moved to ${STATUS_META[status].label}`);
}

// ─────────────────────────── the conversation ───────────────────────────

const KIND: Partial<Record<TaskComment['kind'], { label: string; cls: string }>> = {
  question: { label: 'asks', cls: 'tk-k-ask' },
  answer: { label: 'answered', cls: 'tk-k-answer' },
  handed_in: { label: 'handed it in', cls: 'tk-k-in' },
  approved: { label: 'approved', cls: 'tk-k-ok' },
  sent_back: { label: 'sent it back', cls: 'tk-k-back' },
  handoff: { label: 'handed it over', cls: 'tk-k-in' },
  split: { label: 'divided it', cls: 'tk-k-in' },
};

/** Lines of the task's own record that tell its story between the comments (the rest is on the History tab). */
const STORY = /^(Created|Handed to |Assigned to |Unassigned|Verification failed|Verified and completed|Marked done manually|Merge into |Moved |Stopped|Opened again)/;

function Face({ from, employees }: { from: TaskComment['from']; employees: Record<string, Employee> }) {
  const e = from.kind === 'employee' && from.id ? employees[from.id] : undefined;
  if (e) return <Avatar appearance={e.appearance} size={30} />;
  return (
    <span className={`tk-face ${from.kind === 'office' ? 'tk-face-office' : from.kind === 'employee' ? '' : 'tk-face-boss'}`} aria-hidden>
      {from.kind === 'office' ? '◆' : from.name.replace(/^The /, '').charAt(0).toUpperCase()}
    </span>
  );
}

function Thread({ task }: { task: Task }) {
  const employees = useOffice((s) => s.employees);
  const end = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const out: Array<{ key: string; ts: string; comment?: TaskComment; note?: string }> = [];
    for (const c of task.comments ?? []) out.push({ key: c.id, ts: c.ts, comment: c });
    task.history.forEach((h, i) => {
      if (STORY.test(h.note)) out.push({ key: `h${i}`, ts: h.ts, note: h.note });
    });
    // (Stable for equal times: what was written first stays first.)
    return out.map((r, i) => ({ r, i })).sort((a, b) => a.r.ts.localeCompare(b.r.ts) || a.i - b.i).map((x) => x.r);
  }, [task.comments, task.history]);
  const count = task.comments?.length ?? 0;
  // The newest is what one came for.
  useLayoutEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [count, task.id]);
  return (
    <div className="tk-thread" data-thread>
      {rows.map(({ key, comment: c, note, ts }) =>
        c ? (
          c.kind === 'part_done' ? (
            <div key={key} className="tk-story" data-comment={c.kind}>
              <span className="tk-story-dot" /> {c.body} <span className="faint">· {stamp(c.ts)}</span>
            </div>
          ) : (
            <div key={key} className={`tk-comment ${KIND[c.kind]?.cls ?? ''} ${c.kind === 'question' && !c.answeredBy ? 'tk-open' : ''} ${c.answerTo ? 'tk-reply' : ''}`} data-comment={c.kind} data-from={c.from.kind}>
              <Face from={c.from} employees={employees} />
              <div className="tk-comment-main">
                <div className="tk-comment-head">
                  <b>{c.from.name}</b>
                  {KIND[c.kind] && <span className="tk-kind">{KIND[c.kind]!.label}</span>}
                  {c.kind === 'question' && !c.answeredBy && <span className="tk-waiting">waiting for an answer</span>}
                  <span className="faint" title={new Date(c.ts).toLocaleString()}>
                    {stamp(c.ts)}
                  </span>
                </div>
                <div className="tk-comment-body">
                  <Markdown text={c.body} />
                </div>
                {c.mentions.length > 0 && c.kind !== 'handoff' && <div className="tk-to">to {c.mentions.map((m) => (m.kind === 'boss' ? 'the boss' : m.name)).join(', ')}</div>}
              </div>
            </div>
          )
        ) : (
          <div key={key} className="tk-story">
            <span className="tk-story-dot" /> {note} <span className="faint">· {stamp(ts)}</span>
          </div>
        ),
      )}
      {rows.length === 0 && <div className="muted small">Nothing has been said on this task yet.</div>}
      <div ref={end} />
    </div>
  );
}

// ───────────────────────────── the box at the bottom ─────────────────────────────

/**
 * A text box that offers the office's people when an @ is typed: the boss first, then everybody whose name starts
 * with (or contains) what follows it. Arrows and Enter or Tab choose; Escape closes the list.
 */
function MentionBox({ value, onChange, placeholder, disabled, onSubmit }: { value: string; onChange: (v: string) => void; placeholder: string; disabled?: boolean; onSubmit: () => void }) {
  const employees = useOffice((s) => s.employees);
  const box = useRef<HTMLTextAreaElement>(null);
  const [at, setAt] = useState<{ from: number; word: string } | null>(null);
  const [pick, setPick] = useState(0);
  const options = useMemo(() => {
    if (!at) return [];
    const w = at.word.toLowerCase();
    const names = ['boss', ...activeEmployees(employees).filter((e) => e.roleKey !== 'foreman').map((e) => e.name)];
    return [...names.filter((n) => n.toLowerCase().startsWith(w)), ...names.filter((n) => !n.toLowerCase().startsWith(w) && n.toLowerCase().includes(w))].slice(0, 7);
  }, [at, employees]);
  const look = (text: string, caret: number) => {
    const m = /(^|[\s(])@([\p{L}\p{N}_.-]*)$/u.exec(text.slice(0, caret));
    setAt(m ? { from: caret - m[2]!.length - 1, word: m[2]! } : null);
    setPick(0);
  };
  const choose = (name: string) => {
    if (!at) return;
    const caret = box.current?.selectionStart ?? value.length;
    const next = `${value.slice(0, at.from)}@${name} ${value.slice(caret)}`;
    onChange(next);
    setAt(null);
    const pos = at.from + name.length + 2;
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(pos, pos);
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (at && options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(options[pick]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setAt(null);
        return;
      }
    }
    // ⌘/Ctrl+Enter does what the first button does.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  };
  return (
    <div className="tk-box">
      {at && options.length > 0 && (
        <div className="tk-mentions" role="listbox" aria-label="People to tag">
          {options.map((n, i) => (
            <button key={n} type="button" role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(n)}>
              @{n}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={box}
        value={value}
        disabled={disabled}
        aria-label="Comment"
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          look(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={onKey}
        onBlur={() => setAt(null)}
      />
    </div>
  );
}

function Composer({ task }: { task: Task }) {
  const s = useOffice();
  const can = useAccess();
  const [busy, run] = useAction();
  const [text, setText] = useState('');
  useEffect(() => setText(''), [task.id]);
  const mayWork = can.work(s.projects[task.projectId]?.hostId);
  const who = s.employees[task.assigneeId ?? '']?.name ?? 'the employee';
  const question = openQuestionOf(task);
  const forBoss = !!question && (question.mentions.length === 0 || question.mentions.some((m) => m.kind === 'boss'));
  const waitsForParts = task.waitingFor?.kind === 'parts';
  const mergeFailed = !!task.evidence.merge && !task.evidence.merge.ok;
  const said = text.trim();
  const done = (res: unknown) => {
    if (res !== undefined) setText('');
  };
  const comment = (ok: string) => run(() => api('POST', `/tasks/${task.id}/comments`, { body: said }), ok).then(done);
  const approve = () => run(() => api('POST', `/tasks/${task.id}/review`, { verdict: 'approve', comments: said }), `${task.key} approved`).then(done);
  const sendBack = async () => {
    if (task.status === 'DONE' && !(await ask({ title: `Send ${task.key} back?`, body: `"${task.title}"\n\nIt is opened again${task.assigneeId ? ` for ${who}` : ''} with what you wrote, and is checked and reviewed again when it is handed in. What was done so far stays as it is.`, ok: 'Send it back' }))) return;
    await run(() => api('POST', `/tasks/${task.id}/send-back`, { note: said }), task.status === 'IN_PROGRESS' ? `${who} was told` : `${task.key} sent back`).then(done);
  };
  const unblock = () => run(() => api('POST', `/tasks/${task.id}/unblock`, { note: said }), `${task.key} unblocked`).then(done);

  if (!mayWork) return <div className="tk-compose tk-compose-off small muted">{can.why(s.projects[task.projectId]?.hostId) ?? 'You can read this task, not write on it.'}</div>;
  if (task.kind === 'review') return <div className="tk-compose tk-compose-off small muted">A review is written by the colleague who was asked for it; what there is to say goes on the task it reviews.</div>;

  // What the first button is, and what the box asks for, depends on what the task is waiting for.
  const answering = !!question && (task.status === 'BLOCKED' || (task.status === 'IN_PROGRESS' && forBoss));
  const blocked = task.status === 'BLOCKED' && !question && !waitsForParts;
  let placeholder = 'Write a comment — @ to tag an employee';
  let primary = { label: 'Comment', run: () => comment('Comment added'), need: true, variant: 'primary' as 'primary' | 'success' };
  let hint = task.status === 'IN_PROGRESS' ? `${who} reads it when their current turn ends.` : 'Tag somebody (@Name) to bring it to them; nobody else is told.';
  if (answering) {
    placeholder = `Your answer to ${question!.from.name}…`;
    primary = { label: 'Answer', run: () => comment(task.status === 'BLOCKED' ? `${task.key} is back with ${who}` : 'Answered'), need: true, variant: 'success' };
    hint = task.status === 'BLOCKED' ? `Your answer brings the task back to ${who}.` : `${question!.from.name} is waiting for it right now.`;
  } else if (blocked) {
    placeholder = `What changed, and what ${who} should do now…`;
    primary = { label: 'Unblock', run: unblock, need: false, variant: 'success' };
    hint = `Unblocking sends the task back to ${who} with your note.`;
  } else if (task.status === 'REVIEW') {
    placeholder = 'A note with your approval — or what should change, to send it back';
    primary = { label: 'Approve', run: approve, need: false, variant: 'success' };
    hint = 'Approve lets it finish (merge included). Send back returns it to its author with what you wrote.';
  }
  return (
    <div className="tk-compose" data-compose={answering ? 'answer' : blocked ? 'unblock' : task.status === 'REVIEW' ? 'review' : 'comment'}>
      <MentionBox value={text} onChange={setText} placeholder={placeholder} disabled={busy} onSubmit={() => (primary.need && !said ? undefined : void primary.run())} />
      <div className="tk-compose-row">
        <Button variant={primary.variant} disabled={busy || (primary.need && !said)} onClick={() => void primary.run()} title="⌘/Ctrl + Enter">
          {primary.label}
        </Button>
        {task.status === 'REVIEW' && (
          <>
            <Button variant="danger" disabled={busy || !said} onClick={sendBack} title={said ? undefined : 'Write what should change first'}>
              Send back
            </Button>
            <Button variant="ghost" disabled={busy || !said} onClick={() => comment('Comment added')}>
              Just comment
            </Button>
          </>
        )}
        {task.status === 'DONE' && (
          <Button disabled={busy || !said} onClick={sendBack} title={said ? 'Open it again with what you wrote' : 'Write what should change first'}>
            Send back
          </Button>
        )}
        {task.status === 'IN_PROGRESS' && !answering && (
          <Button disabled={busy || !said} onClick={sendBack} title={`Interrupts ${who}'s current turn: this is the next thing they read`}>
            Tell them now
          </Button>
        )}
        {mergeFailed && task.status === 'BLOCKED' && (
          <Button disabled={busy} onClick={() => run(() => api('POST', `/tasks/${task.id}/retry-merge`, {}), `Merge of ${task.key} retried`)} title="Use this after resolving the conflict by hand in the terminal">
            Retry merge
          </Button>
        )}
        <span className="tk-compose-hint small faint">{hint}</span>
      </div>
    </div>
  );
}

// ───────────────────────────── who is on it, and the rest ─────────────────────────────

function People({ task }: { task: Task }) {
  const s = useOffice();
  const can = useAccess();
  const [busy, run] = useAction();
  const mayWork = can.work(s.projects[task.projectId]?.hostId);
  const patch = (body: Record<string, unknown>, ok: string) => run(() => api('PATCH', `/tasks/${task.id}`, body), ok);
  const assignee = task.assigneeId ? s.employees[task.assigneeId] : undefined;
  // A finished task keeps who it was done by; one in progress is not moved from under them.
  const editable = mayWork && task.status !== 'IN_PROGRESS' && task.status !== 'DONE';
  const helpers = (task.helperIds ?? []).map((id) => s.employees[id]).filter((e): e is Employee => !!e);
  const everyone = activeEmployees(s.employees).filter((e) => e.roleKey !== 'foreman');
  const canHelp = mayWork && task.status !== 'DONE' && !task.parentId && task.kind !== 'review' && !!task.assigneeId;
  const review = reviewByOf(task);
  return (
    <div className="tk-meta" data-ticket-meta>
      <label className="tk-meta-item">
        <span className="tk-meta-label">{helpers.length ? 'Leads it' : 'Assignee'}</span>
        {editable ? (
          <span className="row" style={{ gap: 6 }}>
            {assignee && <Avatar appearance={assignee.appearance} size={20} />}
            <select aria-label="Assignee" className="tk-select" value={task.assigneeId ?? ''} disabled={busy} onChange={(e) => patch({ assigneeId: e.target.value || null }, e.target.value ? `${task.key} assigned to ${s.employees[e.target.value]?.name}` : `${task.key} unassigned`)}>
              <option value="">Unassigned</option>
              {everyone.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </span>
        ) : assignee ? (
          <button type="button" className="tk-person" onClick={() => s.focusEmployee(assignee.id)} title={`${assignee.title} — go to their desk`}>
            <Avatar appearance={assignee.appearance} size={20} />
            {assignee.name}
          </button>
        ) : (
          <span className="muted">unassigned{task.roleHint ? ` · ${task.roleHint}` : ''}</span>
        )}
      </label>
      {(helpers.length > 0 || canHelp) && (
        <div className="tk-meta-item">
          <span className="tk-meta-label">With</span>
          <span className="row row-wrap" style={{ gap: 4 }}>
            {helpers.map((e) => (
              <span key={e.id} className="tk-person-chip on" title={e.title}>
                <Avatar appearance={e.appearance} size={18} />
                {e.name}
                {canHelp && (
                  <button type="button" aria-label={`Take ${e.name} off this task`} disabled={busy} onClick={() => patch({ helperIds: (task.helperIds ?? []).filter((id) => id !== e.id) }, `${e.name} is off ${task.key}`)}>
                    ×
                  </button>
                )}
              </span>
            ))}
            {canHelp && (
              <details className="tk-pop">
                <summary className="tk-add" title="Put a colleague on this task with its assignee" data-add-people>
                  + Add
                </summary>
                <div className="tk-pop-body">
                  <div className="small muted" style={{ padding: '2px 4px 6px' }}>
                    {assignee?.name ?? 'The assignee'} leads the task and divides the work.
                  </div>
                  {everyone
                    .filter((e) => e.id !== task.assigneeId && !(task.helperIds ?? []).includes(e.id))
                    .map((e) => (
                      <button key={e.id} type="button" className="tk-pop-item" disabled={busy} onClick={() => patch({ helperIds: [...(task.helperIds ?? []), e.id] }, `${e.name} is on ${task.key} with ${assignee?.name ?? 'its assignee'}`)}>
                        <Avatar appearance={e.appearance} size={18} />
                        <span className="grow truncate">{e.name}</span>
                        <span className="small faint truncate">{e.title}</span>
                      </button>
                    ))}
                </div>
              </details>
            )}
          </span>
        </div>
      )}
      {task.kind !== 'review' && (
        <label className="tk-meta-item">
          <span className="tk-meta-label">Reviewed by</span>
          {mayWork && task.status !== 'DONE' ? (
            <select aria-label="Reviewed by" className="tk-select" value={review} disabled={busy} title={REVIEW_CHOICES.find((c) => c.id === review)?.hint} onChange={(e) => patch({ reviewBy: e.target.value as ReviewBy }, `${task.key}: ${REVIEW_CHOICES.find((c) => c.id === e.target.value)!.label.toLowerCase()}`)}>
              {REVIEW_CHOICES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <span>{REVIEW_CHOICES.find((c) => c.id === review)!.label}</span>
          )}
        </label>
      )}
      <label className="tk-meta-item">
        <span className="tk-meta-label">Priority</span>
        {editable ? (
          <select aria-label="Priority" className="tk-select" value={task.priority} disabled={busy} onChange={(e) => patch({ priority: e.target.value }, `${task.key} priority set to ${e.target.value}`)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        ) : (
          <span>{task.priority}</span>
        )}
      </label>
    </div>
  );
}

function More({ task, onEdit }: { task: Task; onEdit: () => void }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const menu = useRef<HTMLDetailsElement>(null);
  const who = s.employees[task.assigneeId ?? '']?.name ?? 'the employee';
  const close = () => menu.current?.removeAttribute('open');
  const remove = async () => {
    close();
    const working = task.status === 'IN_PROGRESS';
    if (!(await ask({ title: `${working ? 'Stop and delete' : 'Delete'} ${task.key}?`, body: `"${task.title}"\n\n${working ? `${who} is interrupted and told to leave it; the` : 'The'} task and its record are removed. This cannot be undone. Its branch and folder on the machine are left as they are.`, ok: working ? 'Stop and delete' : 'Delete', danger: true }))) return;
    const res = await run(() => (working ? api('POST', `/tasks/${task.id}/stop`, { then: 'delete' }) : api('DELETE', `/tasks/${task.id}`)), `${task.key} deleted`);
    if (res !== undefined) s.openPanel('tasks');
  };
  return (
    <details className="tk-pop tk-more" ref={menu}>
      <summary className="btn btn-ghost btn-sm" aria-label="More actions" title="More actions" data-more>
        ⋯
      </summary>
      <div className="tk-pop-body tk-pop-right">
        {task.status !== 'DONE' && task.kind !== 'review' && (
          <button type="button" className="tk-pop-item" onClick={() => (close(), onEdit())}>
            Change the task's text…
          </button>
        )}
        {task.status === 'IN_PROGRESS' && (
          <button type="button" className="tk-pop-item" disabled={busy} onClick={() => (close(), void run(() => api('POST', `/tasks/${task.id}/stop`, { then: 'hold' }), `${task.key} stopped and put on hold`))} title={`${who} is interrupted and told to leave it. The task waits, with its branch, until you release it again.`}>
            Stop — put on hold
          </button>
        )}
        {task.status !== 'IN_PROGRESS' && (
          <label className="tk-pop-item tk-pop-select">
            Move to
            <select
              aria-label="Move to another status"
              value=""
              onChange={(e) => {
                if (e.target.value) void moveTask(task, e.target.value as TaskStatus);
                close();
              }}
            >
              <option value="">…</option>
              {TASK_STATUSES.filter((st) => st !== task.status && st !== 'IN_PROGRESS').map((st) => (
                <option key={st} value={st}>
                  {STATUS_META[st].label}
                  {st === 'DONE' ? ' (by hand, unverified)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="tk-pop-item tk-danger" disabled={busy} onClick={remove}>
          {task.status === 'IN_PROGRESS' ? 'Stop and delete…' : 'Delete task…'}
        </button>
      </div>
    </details>
  );
}

/** The task's own text, and changing it. Changing the text of a task somebody is working on tells them. */
function Body({ task, editing, onDone }: { task: Task; editing: boolean; onDone: () => void }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [acceptance, setAcceptance] = useState(task.acceptance);
  /** The place to drop files is opened when wanted: most tasks have none. */
  const [attaching, setAttaching] = useState(false);
  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description);
    setAcceptance(task.acceptance);
  }, [task.id, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const parts = Object.values(s.tasks)
    .filter((t) => t.parentId === task.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const save = async () => {
    const working = task.status === 'IN_PROGRESS';
    const res = await run(() => (working ? api('POST', `/tasks/${task.id}/correct`, { title, description, acceptance, now: false }) : api('PATCH', `/tasks/${task.id}`, { title, description, acceptance })), working ? `${task.key} changed — ${s.employees[task.assigneeId ?? '']?.name ?? 'the employee'} was told` : `${task.key} changed`);
    if (res !== undefined) onDone();
  };
  if (editing) {
    return (
      <div className="tk-body tk-editing" data-ticket-edit>
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" aria-label="Description" style={{ minHeight: 140 }} />
        <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder="Acceptance criteria — how to tell it is done" aria-label="Acceptance criteria" style={{ minHeight: 60 }} />
        <div className="row">
          <Button variant="primary" disabled={busy || !title.trim()} onClick={save}>
            Save
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          {task.status === 'IN_PROGRESS' && <span className="small faint">Whoever is working on it is told what changed.</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="tk-body">
      {task.description ? <Markdown text={task.description} /> : <div className="muted">No description.</div>}
      {task.acceptance && (
        <div className="tk-accept">
          <div className="tk-eyebrow">Done when</div>
          <div className="pre">{task.acceptance}</div>
        </div>
      )}
      {(task.attachments?.length ?? 0) > 0 || attaching ? (
        <TaskFiles task={task} />
      ) : (
        task.status !== 'DONE' && (
          <button type="button" className="tk-link tk-attach" onClick={() => setAttaching(true)}>
            + Attach a picture or a document
          </button>
        )
      )}
      {task.status === 'IN_PROGRESS' && (task.progress.percent != null || task.progress.note) && (
        <div className="tk-progress">
          {task.progress.percent != null && <Progress value={task.progress.percent} />}
          <span className="small muted">
            {task.progress.percent != null ? `${Math.round(task.progress.percent)}% · ` : ''}
            {task.progress.note}
            {task.progress.ts ? ` · ${timeAgo(task.progress.ts)}` : ''}
          </span>
        </div>
      )}
      {parts.length > 0 && (
        <div className="tk-parts" data-ticket-parts>
          <div className="tk-eyebrow">
            Parts — {parts.filter((p) => p.status === 'DONE').length} of {parts.length} done
          </div>
          {parts.map((p) => (
            <button key={p.id} type="button" className="tk-part" onClick={() => s.openPanel('task', p.id)}>
              <span className="dot" style={{ background: STATUS_META[p.status].color }} />
              <span className="mono muted">{p.key}</span>
              <span className="grow truncate">{p.title}</span>
              <span className="small muted">{s.employees[p.assigneeId ?? '']?.name ?? 'unassigned'}</span>
              <Badge tone={STATUS_META[p.status].tone}>{STATUS_META[p.status].label}</Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Details({ task }: { task: Task }) {
  return (
    <dl className="kv small tk-details">
      <dt>Kind</dt>
      <dd>{task.kind}</dd>
      <dt>Branch</dt>
      <dd className="mono">{task.branch ?? <span className="muted">not created yet</span>}</dd>
      <dt>Folder</dt>
      <dd className="mono">{task.worktree ?? <span className="muted">not created yet</span>}</dd>
      {task.baseSha && (
        <>
          <dt>Base commit</dt>
          <dd className="mono">{task.baseSha.slice(0, 10)}</dd>
        </>
      )}
      <dt>Handed over</dt>
      <dd>
        <Delivery delivery={task.delivery} />
      </dd>
      <dt>Created</dt>
      <dd>
        {stamp(task.createdAt)} by {task.createdBy.replace(/^[a-z]+:/, '')}
      </dd>
      <dt>Started</dt>
      <dd>{task.startedAt ? stamp(task.startedAt) : <span className="muted">not yet</span>}</dd>
      <dt>Completed</dt>
      <dd>{task.completedAt ? stamp(task.completedAt) : <span className="muted">not yet</span>}</dd>
    </dl>
  );
}

// ───────────────────────────────── the task ─────────────────────────────────

export function TicketView({ task, tab, onTab }: { task: Task; tab: TicketTab; onTab: (t: TicketTab) => void }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [task.id]);
  // The small menus of the task (people to add, more actions) close when one clicks anywhere else.
  useEffect(() => {
    const away = (e: MouseEvent) => {
      for (const d of document.querySelectorAll<HTMLDetailsElement>('.tk-pop[open]')) if (!d.contains(e.target as Node)) d.removeAttribute('open');
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);
  const project = s.projects[task.projectId];
  const need = needOf(task, s.employees, s.tasks);
  const parent = task.parentId ? s.tasks[task.parentId] : undefined;
  const reviewed = task.reviewOf ? s.tasks[task.reviewOf] : undefined;
  const open = (id: string) => s.openPanel('task', id);
  return (
    <div className="tk-ticket" data-ticket={task.key} data-ticket-status={task.status}>
      {/* In the middle: what the task says and what is said on it. */}
      <div className="tk-pane">
        <Tabs<TicketTab>
          tabs={[
            { id: 'talk', label: 'Conversation', count: task.comments?.length || undefined },
            { id: 'work', label: 'Work' },
            { id: 'changes', label: 'Changes' },
            { id: 'history', label: 'History' },
          ]}
          value={tab}
          onChange={onTab}
        />
        {tab === 'talk' ? (
          <>
            <div className="tk-scroll">
              <Body task={task} editing={editing} onDone={() => setEditing(false)} />
              <Thread task={task} />
            </div>
            <Composer task={task} />
          </>
        ) : (
          <div className="tk-scroll tk-scroll-pad">
            {tab === 'work' && (
              <>
                <Details task={task} />
                <TaskEvidence task={task} />
              </>
            )}
            {tab === 'changes' && <GitChanges path={`/tasks/${task.id}/git`} />}
            {tab === 'history' && <TaskHistory task={task} />}
          </div>
        )}
      </div>
      {/* At the side: where it stands and who is on it — each changed right there. */}
      <aside className="tk-aside">
        <div className="tk-aside-top">
          <span className="tk-status" style={{ color: need.color, borderColor: need.color }} data-ticket-need={need.group}>
            {need.label}
          </span>
          <div className="grow" />
          <More task={task} onEdit={() => (onTab('talk'), setEditing(true))} />
        </div>
        <div className="tk-line">{need.line}</div>
        {!task.released && task.status === 'BACKLOG' && (
          <Button variant="success" small disabled={busy} onClick={() => run(() => api('POST', '/tasks/release', { ids: [task.id] }), `${task.key} released`)}>
            Release
          </Button>
        )}
        <People task={task} />
        <div className="tk-meta">
          <div className="tk-meta-item">
            <span className="tk-meta-label">Project</span>
            {project ? (
              <button type="button" className="pw-chip" onClick={() => s.openPanel('projects', project.id)}>
                <span className="dot" style={{ background: project.color }} />
                <span className="truncate">{project.name}</span>
              </button>
            ) : (
              <span className="muted">unknown project</span>
            )}
          </div>
          {parent && (
            <div className="tk-meta-item">
              <span className="tk-meta-label">Part of</span>
              <button type="button" className="pw-chip" onClick={() => open(parent.id)} title={parent.title}>
                <span className="mono">{parent.key}</span>
                <span className="truncate">{parent.title}</span>
              </button>
            </div>
          )}
          {reviewed && (
            <div className="tk-meta-item">
              <span className="tk-meta-label">Review of</span>
              <button type="button" className="pw-chip" onClick={() => open(reviewed.id)} title={reviewed.title}>
                <span className="mono">{reviewed.key}</span>
                <span className="truncate">{reviewed.title}</span>
              </button>
            </div>
          )}
          <div className="tk-meta-item">
            <span className="tk-meta-label">Kind</span>
            <span>{task.kind}</span>
          </div>
          {task.attempts > 0 && (
            <div className="tk-meta-item">
              <span className="tk-meta-label">Sent back</span>
              <span>{task.attempts}×</span>
            </div>
          )}
          <div className="tk-meta-item">
            <span className="tk-meta-label">Created</span>
            <span className="small">
              {stamp(task.createdAt)} by {task.createdBy.replace(/^[a-z]+:/, '')}
            </span>
          </div>
          {task.completedAt && (
            <div className="tk-meta-item">
              <span className="tk-meta-label">Completed</span>
              <span className="small">{stamp(task.completedAt)}</span>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
