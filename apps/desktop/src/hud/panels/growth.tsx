import { useState, type FormEvent } from 'react';
import type { AutonomyLevel, Employee, EvidenceRef, Improvement, ImprovementAction, Lesson, LessonSource, Project, Task } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Field, Provenance, Tabs, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { registerPanel } from './index.tsx';
import { activeEmployees, plural, stamp, useAction } from './tasks.tsx';
import './panels-work.css';

type PanelProps = { arg: string | null; onClose: () => void };

// ───────────────────────────── evidence ──────────────────────────────

/** A cited record. Opens the record when the office still has it. */
function EvidenceChip({ ev }: { ev: EvidenceRef }) {
  const s = useOffice();
  const task = ev.kind === 'task' ? s.tasks[ev.id] : undefined;
  const open = task ? () => s.openPanel('task', task.id) : ev.kind === 'question' && s.questions[ev.id] ? () => s.openPanel('question', ev.id) : ev.kind === 'meeting' && s.meetings[ev.id] ? () => s.openPanel('meetings', ev.id) : null;
  const label = task ? `task ${task.key}` : ev.kind;
  if (!open) {
    return (
      <Badge tone="muted" title={ev.note}>
        {label}
      </Badge>
    );
  }
  return (
    <button type="button" className="pw-chip" title={ev.note} onClick={open}>
      {label}
    </button>
  );
}

// ──────────────────────────── suggestions ────────────────────────────

const AUTONOMY: AutonomyLevel[] = ['restricted', 'supervised', 'standard', 'autonomous', 'auto'];

/** What applying a suggestion really does, in plain words, and whether it lets agents do more unasked. */
function describeAction(a: ImprovementAction, projects: Record<string, Project>, employees: Record<string, Employee>): { text: string; widens: boolean } {
  const project = (id: string) => `project ${projects[id]?.name ?? '(unknown project)'}`;
  switch (a.type) {
    case 'project.policy.allow':
      return { text: `Adds allow rule ${a.rule} to ${project(a.projectId)}. Sessions started afterwards run matching tools without asking you.`, widens: true };
    case 'project.policy.deny':
      return { text: `Adds deny rule ${a.rule} to ${project(a.projectId)}. Sessions started afterwards are refused matching tools.`, widens: false };
    case 'project.requireReview':
      return a.value
        ? { text: `Turns on required review for ${project(a.projectId)}: code tasks created afterwards need an approved review before they count as DONE.`, widens: false }
        : { text: `Turns off required review for ${project(a.projectId)}: tasks created afterwards no longer wait for a review.`, widens: true };
    case 'project.verifyTimeout': {
      const now = projects[a.projectId]?.verifyTimeoutSec;
      return { text: `Sets the verification timeout of ${project(a.projectId)} to ${a.seconds} seconds${now != null ? ` (now ${now})` : ''}.`, widens: false };
    }
    case 'employee.autonomy': {
      const e = employees[a.employeeId];
      return { text: `Changes the autonomy of ${e?.name ?? '(unknown employee)'}${e ? ` from ${e.autonomy}` : ''} to ${a.level}.`, widens: !e || AUTONOMY.indexOf(a.level) > AUTONOMY.indexOf(e.autonomy) };
    }
    case 'advice':
      return { text: 'Advice only — nothing changes automatically. Applying just records that you took it on board.', widens: false };
  }
}

function Suggestion({ imp }: { imp: Improvement }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const { text, widens } = describeAction(imp.action, s.projects, s.employees);
  const target = imp.projectId ? s.projects[imp.projectId]?.name : imp.employeeId ? s.employees[imp.employeeId]?.name : null;
  return (
    <div className="card col">
      <div className="row spread" style={{ alignItems: 'flex-start' }}>
        <span className="strong">{imp.title}</span>
        <span className="row" style={{ gap: 6 }}>
          {target && <Badge tone="neutral">{target}</Badge>}
          <Badge tone="muted">{imp.kind.replace(/_/g, ' ')}</Badge>
        </span>
      </div>
      <div className="pre">{imp.rationale}</div>
      <div>
        <div className="small faint">{imp.evidence.length ? `Based on ${plural(imp.evidence.length, 'record')}:` : 'No records are cited.'}</div>
        <div className="col" style={{ gap: 4, marginTop: 4 }}>
          {imp.evidence.map((ev, i) => (
            <div key={i} className="row small" style={{ alignItems: 'flex-start' }}>
              <EvidenceChip ev={ev} />
              <span className="grow pre">{ev.note}</span>
            </div>
          ))}
        </div>
      </div>
      <div className={`pw-note ${widens ? 'pw-warn' : ''}`}>
        <span className="strong">If you apply: </span>
        {text}
        {widens && ' This widens what agents may do without asking you.'}
      </div>
      <div className="row">
        <Button variant={widens ? 'default' : 'primary'} disabled={busy} onClick={() => run(() => api('POST', `/improvements/${imp.id}/apply`, {}), `Applied: ${imp.title}`)}>
          {imp.action.type === 'advice' ? 'Mark as taken on board' : widens ? 'Apply — I understand it widens permissions' : 'Apply'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => run(() => api('POST', `/improvements/${imp.id}/dismiss`, {}), 'Suggestion dismissed')}>
          Dismiss
        </Button>
        <span className="small faint">proposed {timeAgo(imp.createdAt)}</span>
      </div>
    </div>
  );
}

function Suggestions() {
  const s = useOffice();
  const [busy, run] = useAction();
  const all = Object.values(s.improvements);
  const proposed = all.filter((i) => i.status === 'proposed').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const decided = all.filter((i) => i.status !== 'proposed').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
  const enabled = s.settings?.selfImprovement.enabled ?? false;
  const analyse = async () => {
    const found = await run(() => api<Improvement[]>('POST', '/improvements/analyze', {}));
    if (found) s.toast(found.length ? `${plural(found.length, 'new suggestion')} from the record` : 'Nothing new: the record supports no further suggestions right now', found.length ? 'success' : 'info');
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row spread">
        <span className="small muted">Orchestrator reads its own recorded history and proposes changes the record supports. Nothing here is applied until you say so.</span>
        <Button small disabled={busy || !enabled} title={enabled ? 'Read the record again now' : 'Self-improvement is switched off in Settings'} onClick={analyse}>
          {busy ? 'Analysing…' : 'Re-analyse now'}
        </Button>
      </div>
      {proposed.length === 0 ? <Empty title="No open suggestions">Suggestions appear when the recorded work shows a pattern, such as the same approval being granted again and again.</Empty> : proposed.map((i) => <Suggestion key={i.id} imp={i} />)}
      {decided.length > 0 && (
        <div>
          <div className="section-title">Already decided ({decided.length})</div>
          <table className="tbl">
            <tbody>
              {decided.map((i) => (
                <tr key={i.id}>
                  <td style={{ width: 1 }}>
                    <Badge tone={i.status === 'applied' ? 'good' : 'muted'}>{i.status}</Badge>
                  </td>
                  <td title={i.rationale}>
                    {i.title}
                    <div className="small muted">{describeAction(i.action, s.projects, s.employees).text}</div>
                  </td>
                  <td className="small faint" style={{ whiteSpace: 'nowrap' }}>
                    {i.decidedAt ? stamp(i.decidedAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────── lessons ──────────────────────────────

const SOURCE: Record<LessonSource, { label: string; tone: Tone; title: string }> = {
  owner_answer: { label: "boss's decision", tone: 'accent', title: 'Captured from an answer you gave to a question' },
  owner: { label: 'taught by you', tone: 'accent', title: 'You wrote this lesson' },
  retrospective: { label: 'retrospective', tone: 'info', title: "Recorded by the employee's own session after a task" },
  meeting: { label: 'meeting', tone: 'neutral', title: 'Came out of a meeting' },
  orchestrator: { label: 'orchestrator', tone: 'muted', title: 'Recorded by Orchestrator from its history' },
};
const STATUS_RANK: Record<Lesson['status'], number> = { proposed: 0, active: 1, retired: 2 };

function lessonOrder(a: Lesson, b: Lesson): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.createdAt.localeCompare(a.createdAt);
}

function LessonRow({ lesson, scope }: { lesson: Lesson; scope?: string }) {
  const [busy, run] = useAction();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(lesson.text);
  const [when, setWhen] = useState(lesson.appliesWhen);
  const source = SOURCE[lesson.source];
  const setStatus = (status: Lesson['status'], ok: string) => run(() => api('PATCH', `/lessons/${lesson.id}`, { status }), ok);
  const edit = () => {
    setText(lesson.text);
    setWhen(lesson.appliesWhen);
    setEditing(true);
  };
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    if (text.trim().length < 8 || busy) return;
    const res = await run(() => api('PATCH', `/lessons/${lesson.id}`, { text, appliesWhen: when }), 'Lesson updated');
    if (res) setEditing(false);
  };
  return (
    <div className={`card col ${lesson.status === 'retired' ? 'pw-dim' : ''}`}>
      {editing ? (
        <form className="col" onSubmit={save}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} aria-label="Lesson" style={{ minHeight: 56 }} autoFocus />
          <input value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Applies when" placeholder="Applies when… (optional)" />
          <div className="row">
            <Button small variant="primary" type="submit" disabled={busy || text.trim().length < 8}>
              Save
            </Button>
            <Button small variant="ghost" type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            {text.trim().length < 8 && <span className="small muted">A lesson needs to be a full sentence.</span>}
          </div>
        </form>
      ) : (
        <div>
          <div className="pre">{lesson.text}</div>
          {lesson.appliesWhen && <div className="small muted">Applies: {lesson.appliesWhen}</div>}
        </div>
      )}
      <div className="row row-wrap small">
        {lesson.status !== 'active' && <Badge tone={lesson.status === 'proposed' ? 'warn' : 'muted'}>{lesson.status === 'proposed' ? 'waiting for your approval' : 'retired'}</Badge>}
        {scope && <Badge tone="neutral">{scope}</Badge>}
        <Badge tone={source.tone} title={source.title}>
          {source.label}
        </Badge>
        <span className="muted">
          by {lesson.authoredBy.name} · {timeAgo(lesson.createdAt)}
        </span>
        <span className="muted" title="How many prompts Orchestrator has included this lesson in (counted)">
          · used in {plural(lesson.appliedCount, 'prompt')}
        </span>
        {lesson.evidence.map((ev, i) => (
          <EvidenceChip key={i} ev={ev} />
        ))}
        <div className="grow" />
        {lesson.status === 'proposed' && (
          <>
            <Button small variant="success" disabled={busy} onClick={() => setStatus('active', 'Lesson approved: it is included in prompts from now on')}>
              Approve
            </Button>
            <Button small disabled={busy} onClick={() => setStatus('retired', 'Lesson rejected: kept for the record only')}>
              Reject
            </Button>
          </>
        )}
        {lesson.status === 'active' && (
          <Button small variant="ghost" disabled={busy} onClick={() => setStatus('retired', 'Lesson retired: no longer included in prompts')}>
            Retire
          </Button>
        )}
        {lesson.status === 'retired' && (
          <Button small variant="ghost" disabled={busy} onClick={() => setStatus('active', 'Lesson reactivated')}>
            Reactivate
          </Button>
        )}
        {!editing && lesson.status !== 'retired' && (
          <Button small variant="ghost" onClick={edit}>
            Edit
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * First-pass counts before and since an employee's first active lesson.
 * Counted the way the server counts the track record: completed, non-review
 * tasks the employee reported on, with no failed verification and no rejected review.
 */
function BeforeAfter({ employeeId, lessons }: { employeeId: string; lessons: Lesson[] }) {
  const tasks = useOffice((s) => s.tasks);
  const done = Object.values(tasks).filter((t): t is Task & { completedAt: string } => t.assigneeId === employeeId && t.status === 'DONE' && t.kind !== 'review' && !!t.evidence.summary && !!t.completedAt);
  const tally = (list: Task[]) => `${list.filter((t) => t.friction.failedVerifications === 0 && t.friction.reviewRejections === 0).length}/${list.length}`;
  const since = lessons
    .filter((l) => l.status === 'active')
    .map((l) => l.createdAt)
    .sort()[0];
  return (
    <div className="row row-wrap small">
      <Provenance kind="measured" />
      {done.length === 0 ? (
        <span className="muted">No completed tasks on record yet, so there is nothing to compare.</span>
      ) : since ? (
        <span>
          First-pass tasks — before first lesson: <span className="mono strong">{tally(done.filter((t) => t.completedAt < since))}</span> · since: <span className="mono strong">{tally(done.filter((t) => t.completedAt >= since))}</span>
        </span>
      ) : (
        <span>
          First-pass tasks: <span className="mono strong">{tally(done)}</span> · no active lesson yet
        </span>
      )}
      {done.length > 0 && (
        <span className="faint" title={since ? `First active lesson recorded ${stamp(since)}` : undefined}>
          Counts from the task records — not proof that the lessons caused any difference.
        </span>
      )}
    </div>
  );
}

function Playbooks() {
  const s = useOffice();
  const byEmployee = new Map<string, Lesson[]>();
  for (const l of Object.values(s.lessons)) {
    if (l.scope !== 'employee' || !l.employeeId) continue;
    byEmployee.set(l.employeeId, [...(byEmployee.get(l.employeeId) ?? []), l]);
  }
  const groups = [...byEmployee.entries()].map(([id, lessons]) => ({ id, employee: s.employees[id], lessons: lessons.sort(lessonOrder) })).sort((a, b) => (a.employee?.name ?? '').localeCompare(b.employee?.name ?? ''));
  if (!groups.length) {
    return <Empty title="No playbooks yet">An employee's playbook fills up when their session records what it learned after a task, or when you teach them something under Teach. Active lessons are included in their future prompts.</Empty>;
  }
  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="small muted">What each employee has learned from real work. Active lessons are added to the prompts of their future tasks.</div>
      {groups.map(({ id, employee, lessons }) => (
        <div key={id} className="col">
          <div className="row">
            {employee && <Avatar appearance={employee.appearance} size={32} />}
            <div className="grow">
              <div className="strong">{employee?.name ?? 'Unknown employee'}</div>
              <div className="small muted">
                {employee ? `${employee.title} · ` : ''}
                {plural(lessons.filter((l) => l.status === 'active').length, 'active lesson')}
              </div>
            </div>
            {employee && (
              <Button small variant="ghost" onClick={() => s.openPanel('employee', employee.id)}>
                Profile
              </Button>
            )}
          </div>
          <BeforeAfter employeeId={id} lessons={lessons} />
          {lessons.map((l) => (
            <LessonRow key={l.id} lesson={l} />
          ))}
        </div>
      ))}
    </div>
  );
}

function TeamKnowledge() {
  const s = useOffice();
  const shared = Object.values(s.lessons)
    .filter((l) => l.scope !== 'employee')
    .sort(lessonOrder);
  const scopeOf = (l: Lesson) => (l.scope === 'company' ? 'whole company' : `project ${(l.projectId && s.projects[l.projectId]?.name) || '(unknown)'}`);
  const proposed = shared.filter((l) => l.status === 'proposed');
  const active = shared.filter((l) => l.status === 'active');
  const retired = shared.filter((l) => l.status === 'retired');
  const scopes = [...new Set(active.map(scopeOf))].sort((a, b) => Number(b === 'whole company') - Number(a === 'whole company') || a.localeCompare(b));
  if (!shared.length) {
    return <Empty title="No shared knowledge yet">Decisions you give in answers, lessons employees propose for the team and things you teach a project or the company are kept here and included in everyone's prompts.</Empty>;
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="small muted">Knowledge shared by a whole project or the whole company. Active entries are included in the prompts of everyone they apply to, so nobody has to ask again.</div>
      {proposed.length > 0 && (
        <>
          <div className="section-title">Waiting for your decision ({proposed.length})</div>
          {proposed.map((l) => (
            <LessonRow key={l.id} lesson={l} scope={scopeOf(l)} />
          ))}
        </>
      )}
      {scopes.map((scope) => (
        <div key={scope} className="col" style={{ gap: 6 }}>
          <div className="section-title">Active — {scope}</div>
          {active
            .filter((l) => scopeOf(l) === scope)
            .map((l) => (
              <LessonRow key={l.id} lesson={l} />
            ))}
        </div>
      ))}
      {retired.length > 0 && (
        <>
          <div className="section-title">Retired or rejected ({retired.length}) — kept for the record, not used in prompts</div>
          {retired.map((l) => (
            <LessonRow key={l.id} lesson={l} scope={scopeOf(l)} />
          ))}
        </>
      )}
    </div>
  );
}

// ──────────────────────────── track record ───────────────────────────

function TrackRecord() {
  const s = useOffice();
  const si = s.settings?.selfImprovement;
  const routing = !!si?.enabled && si.learnedRouting;
  const rows = [...s.performance].sort((a, b) => (s.employees[a.employeeId]?.name ?? '').localeCompare(s.employees[b.employeeId]?.name ?? '') || a.kind.localeCompare(b.kind));
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row row-wrap small">
        <Provenance kind="measured" />
        <span className="muted">Counted from task records: completed tasks per employee and kind, and what went wrong on the way. First-pass means no failed verification and no rejected review.</span>
      </div>
      <div className={`pw-note ${routing ? '' : 'pw-warn'}`}>
        {routing
          ? 'Learned routing is on: between equally suitable employees the scheduler prefers the better first-pass record, once someone has at least 2 completed tasks of that kind.'
          : 'Learned routing is off, so these counts do not influence who gets a task. When it is on, the scheduler prefers the better record once someone has at least 2 completed tasks of a kind.'}
      </div>
      {rows.length === 0 ? (
        <Empty title="No track record yet">Rows appear when employees complete tasks.</Empty>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Task kind</th>
              <th>Completed</th>
              <th>First-pass</th>
              <th>Failed verifications</th>
              <th>Review rejections</th>
              <th>Merge conflicts</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const e = s.employees[r.employeeId];
              return (
                <tr key={`${r.employeeId}:${r.kind}`}>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      {e && <Avatar appearance={e.appearance} size={22} />}
                      {e?.name ?? 'Unknown employee'}
                    </span>
                  </td>
                  <td>
                    <Badge tone="muted">{r.kind}</Badge>
                  </td>
                  <td className="mono">{r.completed}</td>
                  <td className="mono">
                    {r.firstPass}/{r.completed}
                  </td>
                  <td className="mono">{r.failedVerifications}</td>
                  <td className="mono">{r.reviewRejections}</td>
                  <td className="mono">{r.mergeConflicts}</td>
                  <td>{r.completed >= 2 ? routing && <Badge tone="info">used for routing</Badge> : <span className="small faint">too few for routing</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─────────────────────────────── teach ───────────────────────────────

function Teach() {
  const s = useOffice();
  const [busy, run] = useAction();
  const employees = activeEmployees(s.employees);
  const projects = Object.values(s.projects)
    .filter((p) => p.status !== 'archived')
    .sort((a, b) => a.name.localeCompare(b.name));
  const [scope, setScope] = useState<Lesson['scope']>('employee');
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '');
  const [projectId, setProjectId] = useState(s.filter.projectId ?? projects[0]?.id ?? '');
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const target = scope === 'employee' ? employeeId : scope === 'project' ? projectId : 'company';
  const ready = text.trim().length >= 8 && !!target;
  const enabled = s.settings?.selfImprovement.enabled ?? false;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!ready || busy) return;
    const lesson = await run(() => api<Lesson>('POST', '/lessons', { text, appliesWhen: when, scope, ...(scope === 'employee' ? { employeeId } : scope === 'project' ? { projectId } : {}) }));
    if (lesson) {
      s.toast(enabled ? 'Lesson recorded and active: it is included in prompts from now on' : 'Lesson recorded. It is not used in prompts while self-improvement is off', 'success');
      setText('');
      setWhen('');
    }
  };

  return (
    <form className="pw-form" onSubmit={submit} style={{ maxWidth: 760 }}>
      <div className="small muted field-wide">Tell your team something once. A lesson you teach is active immediately and is added, in your words, to the prompts of the future tasks it applies to.</div>
      {!enabled && <div className="pw-note pw-warn field-wide">Self-improvement is switched off, so lessons are stored but not included in prompts until you turn it on in Settings.</div>}
      <Field label="Who is it for">
        <select value={scope} onChange={(e) => setScope(e.target.value as Lesson['scope'])}>
          <option value="employee">One employee (their playbook)</option>
          <option value="project">Everyone on a project</option>
          <option value="company">The whole company</option>
        </select>
      </Field>
      {scope === 'employee' && (
        <Field label="Employee">
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            {employees.length === 0 && <option value="">No employees yet</option>}
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} — {e.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      {scope === 'project' && (
        <Field label="Project">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {scope === 'company' && <div className="field" />}
      <Field label="Lesson" hint="Phrase it as an instruction, in a full sentence." wide>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Always run the migration check before touching the schema." />
      </Field>
      <Field label="Applies when (optional)" wide>
        <input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="when changing an API contract" />
      </Field>
      <div className="row field-wide">
        <Button variant="primary" type="submit" disabled={busy || !ready}>
          Teach
        </Button>
      </div>
    </form>
  );
}

// ─────────────────────────────── panel ───────────────────────────────

const TABS = ['suggestions', 'playbooks', 'knowledge', 'record', 'teach'] as const;
type GrowthTab = (typeof TABS)[number];
const RETROSPECTIVES = { off: 'never', friction: 'after tasks that hit friction', always: 'after every task' } as const;

/** arg: optionally the tab to open on. */
function GrowthPanel({ arg, onClose }: PanelProps) {
  const s = useOffice();
  const [tab, setTab] = useState<GrowthTab>(() => TABS.find((t) => t === arg) ?? 'suggestions');
  const si = s.settings?.selfImprovement;
  const lessons = Object.values(s.lessons);
  // Tab counts are what is waiting for the owner's decision.
  const waiting = (pick: (l: Lesson) => boolean) => lessons.filter((l) => l.status === 'proposed' && pick(l)).length;
  return (
    <Window title="Growth" subtitle="How the office learns from its own recorded work" onClose={onClose} width={1120} flush>
      <div className="pw-frame">
        <Tabs<GrowthTab>
          tabs={[
            { id: 'suggestions', label: 'Suggestions', count: Object.values(s.improvements).filter((i) => i.status === 'proposed').length },
            { id: 'playbooks', label: 'Playbooks', count: waiting((l) => l.scope === 'employee') },
            { id: 'knowledge', label: 'Team knowledge', count: waiting((l) => l.scope !== 'employee') },
            { id: 'record', label: 'Track record' },
            { id: 'teach', label: 'Teach' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {si && (
          <div className="pw-toolbar">
            <Badge tone={si.enabled ? 'good' : 'warn'}>self-improvement {si.enabled ? 'on' : 'off'}</Badge>
            <span className="small muted grow">
              Retrospectives: {RETROSPECTIVES[si.retrospectives]} · Lessons proposed for the team: {si.autoApproveSharedLessons ? 'active without your review' : 'wait for your approval'} · Learned routing: {si.learnedRouting ? 'on' : 'off'}
            </span>
            <Button small variant="ghost" onClick={() => s.openPanel('settings')}>
              Change in Settings
            </Button>
          </div>
        )}
        <div className="pw-body">
          {tab === 'suggestions' && <Suggestions />}
          {tab === 'playbooks' && <Playbooks />}
          {tab === 'knowledge' && <TeamKnowledge />}
          {tab === 'record' && <TrackRecord />}
          {tab === 'teach' && <Teach />}
        </div>
      </div>
    </Window>
  );
}

registerPanel('growth', GrowthPanel);
