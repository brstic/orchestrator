import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { AutonomyLevel, Employee, EvidenceRef, Improvement, ImprovementAction, Lesson, LessonSource, OrchestratorEvent, OutcomesReport, Project, SelfImprovementSettings, Task } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Field, Tabs, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { registerPanel } from './index.tsx';
import { activeEmployees, plural, stamp, useAction } from './tasks.tsx';
import './panels-work.css';

type PanelProps = { arg: string | null; onClose: () => void };
type Dial = SelfImprovementSettings['autopilot'];

// ─────────────────────── what the office does with what it learns ───────────────────────

/** The three positions of the dial, in the owner's words. `now` is what the office is doing in that position. */
const DIAL: Array<{ value: Dial; label: string; now: string }> = [
  { value: 'off', label: 'Ask me first', now: 'The office asks you before it changes anything. Nothing happens without you.' },
  { value: 'safe', label: 'Apply what is safe', now: 'The office applies by itself what cannot give employees more freedom, and asks you about the rest.' },
  { value: 'trusted', label: 'Apply more on a clean record', now: 'The office also gives employees more freedom by itself when their record is clean — never for risky commands. It asks you about the rest.' },
];

/**
 * The one control for how much the office does by itself with what it learns. The same component is
 * the top line of the Growth window and the first thing under Settings → Growth.
 */
export function AutopilotDial({ inSettings = false }: { inSettings?: boolean }) {
  const si = useOffice((s) => s.settings?.selfImprovement);
  const owner = useOffice((s) => s.me?.role === 'owner');
  const openPanel = useOffice((s) => s.openPanel);
  const [busy, run] = useAction();
  if (!si) return null;
  const set = (patch: Partial<SelfImprovementSettings>, ok: string) => void run(() => api('PATCH', '/settings', { selfImprovement: patch }), ok);
  if (!si.enabled) {
    // In Settings the switch itself is right above; saying it twice would only be noise.
    if (inSettings) return null;
    return (
      <div className="gr-dial">
        <div className="row row-wrap">
          <span className="strong grow">Learning is switched off: nothing is recorded, proposed or applied.</span>
          <Button small variant="primary" disabled={busy || !owner} title={owner ? undefined : 'Only an owner of this office can change this'} onClick={() => set({ enabled: true }, 'Learning is on')}>
            Switch on
          </Button>
        </div>
      </div>
    );
  }
  const current = DIAL.find((d) => d.value === si.autopilot) ?? DIAL[1]!;
  return (
    <div className={`gr-dial ${inSettings ? 'gr-dial-plain' : ''}`}>
      <div className="row">
        <span className="strong grow">{current.now}</span>
        {!inSettings && (
          <Button small variant="ghost" title="When employees are asked to reflect, who approves lessons for the team, learned routing" onClick={() => openPanel('settings', 'improve')}>
            More settings
          </Button>
        )}
      </div>
      <div className="gr-dial-choices" role="radiogroup" aria-label="What the office does with what it learns">
        {DIAL.map((d) => (
          <button key={d.value} type="button" role="radio" aria-checked={d.value === current.value} className={`gr-choice ${d.value === current.value ? 'gr-choice-on' : ''}`} disabled={busy || !owner} title={owner ? undefined : 'Only an owner of this office can change this'} onClick={() => d.value !== current.value && set({ autopilot: d.value }, 'Saved')}>
            {d.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── evidence ──────────────────────────────

/** A cited record. Opens the record when the office still has it. */
function EvidenceChip({ ev }: { ev: EvidenceRef }) {
  const s = useOffice();
  const task = ev.kind === 'task' ? s.tasks[ev.id] : undefined;
  const question = (ev.kind === 'question' || ev.kind === 'approval') && s.questions[ev.id];
  const open = task ? () => s.openPanel('task', task.id) : question ? () => s.openPanel('question', ev.id) : ev.kind === 'meeting' && s.meetings[ev.id] ? () => s.openPanel('meetings', ev.id) : null;
  const label = task ? `task ${task.key}` : ev.kind === 'event' ? 'record' : ev.kind;
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

/** What a proposal rests on, in plain words: the first few records, the rest on request. */
function Evidence({ evidence }: { evidence: EvidenceRef[] }) {
  const [all, setAll] = useState(false);
  if (!evidence.length) return <div className="small faint">No records are cited.</div>;
  const shown = all ? evidence : evidence.slice(0, 3);
  return (
    <div>
      <div className="small faint">Based on {plural(evidence.length, 'record')}:</div>
      <div className="col" style={{ gap: 4, marginTop: 4 }}>
        {shown.map((ev, i) => (
          <div key={i} className="row small" style={{ alignItems: 'flex-start' }}>
            <EvidenceChip ev={ev} />
            <span className="grow pre">{ev.note}</span>
          </div>
        ))}
        {evidence.length > shown.length && (
          <div>
            <Button small variant="ghost" onClick={() => setAll(true)}>
              Show all {evidence.length}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────── waiting for you ────────────────────────────

const AUTONOMY: AutonomyLevel[] = ['restricted', 'supervised', 'standard', 'autonomous', 'auto'];

/** What saying yes really does, in plain words, and whether it lets agents do more without asking. */
function describeAction(a: ImprovementAction, projects: Record<string, Project>, employees: Record<string, Employee>, tasks: Record<string, Task>): { text: string; widens: boolean } {
  const project = (id: string) => projects[id]?.name ?? '(a project that no longer exists)';
  const person = (id: string) => employees[id]?.name ?? '(someone who no longer works here)';
  switch (a.type) {
    case 'project.policy.allow':
      return { text: `Employees on ${project(a.projectId)} may run ${a.rule} without asking you (in sessions started from now on).`, widens: true };
    case 'project.policy.deny':
      return { text: `Employees on ${project(a.projectId)} are refused ${a.rule} without it reaching you (in sessions started from now on).`, widens: false };
    case 'project.requireReview':
      return a.value
        ? { text: `New code tasks in ${project(a.projectId)} need an approved review before they count as done.`, widens: false }
        : { text: `New tasks in ${project(a.projectId)} no longer wait for a review.`, widens: true };
    case 'project.verifyTimeout': {
      const now = projects[a.projectId]?.verifyTimeoutSec;
      return { text: `Verification in ${project(a.projectId)} gets ${a.seconds} seconds${now != null && now !== a.seconds ? ` instead of ${now}` : ''} before it counts as failed.`, widens: false };
    }
    case 'employee.autonomy': {
      const e = employees[a.employeeId];
      return { text: `${person(a.employeeId)}'s autonomy changes${e && e.autonomy !== a.level ? ` from ${e.autonomy}` : ''} to ${a.level}.`, widens: !e || AUTONOMY.indexOf(a.level) > AUTONOMY.indexOf(e.autonomy) };
    }
    case 'task.dependsOn': {
      const [task, first] = [tasks[a.taskId], tasks[a.dependsOnTaskId]];
      return { text: `${task?.key ?? 'The task'} starts only when ${first?.key ?? 'the other task'} is done.`, widens: false };
    }
    case 'project.routing':
      return { text: `${a.kind} tasks in ${project(a.projectId)} go to ${person(a.employeeId)} whenever they are free; otherwise to whoever else is suitable.`, widens: false };
    case 'project.notes.append':
      return { text: `This line is added to the notes of ${project(a.projectId)}, which every employee on it reads: ${a.text}`, widens: false };
    case 'advice':
      return { text: 'Nothing changes by itself: this is advice for you to act on.', widens: false };
    default:
      // An action this window does not know yet (a newer office): say so rather than guess.
      return { text: `The office makes the change it describes above (${(a as { type: string }).type}).`, widens: false };
  }
}

function Proposal({ imp }: { imp: Improvement }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const owner = s.me?.role === 'owner';
  const { text, widens } = describeAction(imp.action, s.projects, s.employees, s.tasks);
  const advice = imp.action.type === 'advice';
  const about = imp.projectId ? s.projects[imp.projectId]?.name : imp.employeeId ? s.employees[imp.employeeId]?.name : null;
  return (
    <div className="card col">
      <div className="row spread" style={{ alignItems: 'flex-start' }}>
        <span className="strong">{imp.title}</span>
        {about && <Badge tone="neutral">{about}</Badge>}
      </div>
      <div className="pre">{imp.rationale}</div>
      <Evidence evidence={imp.evidence} />
      {!advice && (
        <div className={`pw-note ${widens ? 'pw-warn' : ''}`}>
          <span className="strong">If you say yes: </span>
          {text}
          {widens && ' This lets employees do more without asking you.'}
        </div>
      )}
      <div className="row">
        <Button variant={widens ? 'default' : 'primary'} disabled={busy || !owner} title={owner ? undefined : 'Only an owner of this office decides this'} onClick={() => run(() => api('POST', `/improvements/${imp.id}/apply`, {}), advice ? 'Noted' : `Done: ${imp.title}`)}>
          {advice ? 'Got it' : widens ? 'Yes, allow it' : 'Yes, do it'}
        </Button>
        <Button variant="ghost" disabled={busy || !owner} onClick={() => run(() => api('POST', `/improvements/${imp.id}/dismiss`, {}), 'Left as it is')}>
          No
        </Button>
        <span className="small faint">
          {advice ? 'Advice — nothing changes by itself · ' : ''}
          {timeAgo(imp.createdAt)}
        </span>
      </div>
    </div>
  );
}

const SOURCE: Record<LessonSource, { label: string; tone: Tone; title: string }> = {
  owner_answer: { label: 'your decision', tone: 'accent', title: 'Kept from an answer you gave to a question' },
  owner: { label: 'taught by you', tone: 'accent', title: 'You wrote this lesson' },
  retrospective: { label: 'learned from a task', tone: 'info', title: 'Written by the employee after a task, from what was recorded while they worked' },
  meeting: { label: 'from a meeting', tone: 'neutral', title: 'Came out of a meeting' },
  orchestrator: { label: 'from the record', tone: 'muted', title: "Written by the office from its own recorded history" },
};

function whoseLesson(l: Lesson, employees: Record<string, Employee>, projects: Record<string, Project>): string {
  if (l.scope === 'employee') return employees[l.employeeId ?? '']?.name ?? 'one employee';
  if (l.scope === 'project') return `everyone on ${projects[l.projectId ?? '']?.name ?? 'a project'}`;
  return 'the whole company';
}

/** A lesson someone proposed for the team: it is used only once the owner says yes. */
function ProposedLesson({ lesson }: { lesson: Lesson }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const setStatus = (status: Lesson['status'], ok: string) => run(() => api('PATCH', `/lessons/${lesson.id}`, { status }), ok);
  return (
    <div className="card col">
      <div className="row spread" style={{ alignItems: 'flex-start' }}>
        <span className="strong">
          {lesson.authoredBy.name} proposes a lesson for {whoseLesson(lesson, s.employees, s.projects)}
        </span>
      </div>
      <div className="pre">{lesson.text}</div>
      {lesson.appliesWhen && <div className="small muted">Applies: {lesson.appliesWhen}</div>}
      <Evidence evidence={lesson.evidence} />
      <div className="pw-note">
        <span className="strong">If you say yes: </span>
        It is added to the task prompts of {whoseLesson(lesson, s.employees, s.projects)} from now on.
      </div>
      <div className="row">
        <Button variant="primary" disabled={busy} onClick={() => setStatus('active', 'Lesson approved: it is used from now on')}>
          Yes, use it
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setStatus('retired', 'Lesson not used; kept for the record')}>
          No
        </Button>
        <span className="small faint">{timeAgo(lesson.createdAt)}</span>
      </div>
    </div>
  );
}

function WaitingForYou() {
  const s = useOffice();
  const [busy, run] = useAction();
  const all = Object.values(s.improvements);
  const proposals = all.filter((i) => i.status === 'proposed').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lessons = Object.values(s.lessons)
    .filter((l) => l.status === 'proposed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const decided = all.filter((i) => i.status !== 'proposed').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
  const enabled = s.settings?.selfImprovement.enabled ?? false;
  const look = async () => {
    const found = await run(() => api<Improvement[]>('POST', '/improvements/analyze', {}));
    if (found) s.toast(found.length ? `${plural(found.length, 'new proposal')} from the record` : 'Nothing new: the record supports nothing further right now', found.length ? 'success' : 'info');
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row spread">
        <span className="small muted">What the office found in its own recorded work and will not do without you. Each one says what it is based on.</span>
        <Button small disabled={busy || !enabled} title={enabled ? 'Read the recorded work again now (it also happens by itself after every finished task)' : 'Learning is switched off'} onClick={look}>
          {busy ? 'Looking…' : 'Look again now'}
        </Button>
      </div>
      {proposals.length + lessons.length === 0 && <Empty title="Nothing is waiting for you">Proposals appear here when the recorded work shows a pattern — never from a single incident.</Empty>}
      {lessons.map((l) => (
        <ProposedLesson key={l.id} lesson={l} />
      ))}
      {proposals.map((i) => (
        <Proposal key={i.id} imp={i} />
      ))}
      {decided.length > 0 && (
        <details className="gr-details">
          <summary>Decided earlier ({decided.length})</summary>
          <table className="tbl">
            <tbody>
              {decided.map((i) => (
                <DecidedRow key={i.id} imp={i} />
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

const DECIDED: Record<string, { label: string; tone: Tone }> = { applied: { label: 'yes', tone: 'good' }, dismissed: { label: 'no', tone: 'muted' }, reverted: { label: 'undone', tone: 'warn' } };

function DecidedRow({ imp }: { imp: Improvement }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const status = DECIDED[imp.status] ?? { label: String(imp.status), tone: 'muted' as Tone };
  const undoable = imp.status === 'applied' && imp.action.type !== 'advice' && s.me?.role === 'owner';
  return (
    <tr>
      <td style={{ width: 1 }}>
        <Badge tone={status.tone}>{status.label}</Badge>
      </td>
      <td title={imp.rationale}>
        {imp.title}
        {imp.action.type !== 'advice' && <div className="small muted">{describeAction(imp.action, s.projects, s.employees, s.tasks).text}</div>}
      </td>
      <td className="small faint" style={{ whiteSpace: 'nowrap' }}>
        {imp.decidedAt ? stamp(imp.decidedAt) : '—'}
      </td>
      <td style={{ width: 1 }}>
        {undoable && (
          <Button small variant="ghost" disabled={busy} onClick={() => run(() => api('POST', `/improvements/${imp.id}/revert`, {}), `Undone: ${imp.title}`)}>
            Undo
          </Button>
        )}
      </td>
    </tr>
  );
}

// ──────────────────────────── done by itself ────────────────────────────

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

interface UndoStep {
  /** Already reversed (or no longer as the office left it): nothing to offer. */
  done: boolean;
  run: () => Promise<unknown>;
}

/**
 * How to reverse what a `learning.*` event did, from its `data.undo` as the office writes it:
 *  - `improvementId`: an applied change → POST /improvements/:id/revert (learning/autopilot.ts);
 *  - `type: 'unmerge' | 'retire'`: two lessons folded into one, or a lesson promoted to the project
 *    → POST /playbook/revert with this event's id (learning/playbook.ts);
 *  - `lessonId` with a `status` (or none): a lesson the office retired or made active → PATCH /lessons/:id.
 * Null when there is nothing to reverse, or nothing a person would want to (a counter, a mark).
 */
function undoStep(e: OrchestratorEvent, improvements: Record<string, Improvement>, lessons: Record<string, Lesson>, reverted: Set<string>): UndoStep | null {
  const data = e.data ?? {};
  const undo = obj(data.undo);
  if (!undo) return null;
  const improvementId = text(undo.improvementId);
  if (improvementId) {
    const imp = improvements[improvementId];
    return { done: !!imp && imp.status !== 'applied', run: () => api('POST', `/improvements/${improvementId}/revert`, {}) };
  }
  const kind = text(undo.type);
  if (kind === 'unmerge' || kind === 'retire') return { done: reverted.has(e.id), run: () => api('POST', '/playbook/revert', { eventId: e.id }) };
  // A counter or a mark (how often something was missed, "shown to help") is not something to undo by hand.
  if (kind === 'lesson.proven' || 'captureMustInclude' in undo) return null;
  const id = text(undo.lessonId);
  const now = id ? lessons[id] : undefined;
  if (!id || !now) return null;
  const status = text(undo.status) ?? (now.status === 'retired' ? 'active' : 'retired');
  return { done: now.status === status, run: () => api('PATCH', `/lessons/${id}`, { status }) };
}

function LogRow({ e, reverted }: { e: OrchestratorEvent; reverted: Set<string> }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const [undone, setUndone] = useState(false);
  const what = text(e.data?.what) ?? e.summary;
  const why = text(e.data?.why);
  const evidence = Array.isArray(e.data?.evidence) ? (e.data.evidence as unknown[]).map(obj).filter((x): x is Record<string, unknown> => !!x && typeof x.kind === 'string' && typeof x.id === 'string') : [];
  const step = undoStep(e, s.improvements, s.lessons, reverted);
  const reversal = /revert|undone|undo/.test(e.type);
  const about = e.projectId ? s.projects[e.projectId]?.name : e.employeeId ? s.employees[e.employeeId]?.name : null;
  return (
    <div className="card col" style={{ gap: 6 }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <div className="strong">{what}</div>
          {why && <div className="small muted pre">Why: {why}</div>}
        </div>
        {step && !step.done && !undone && s.me?.role === 'owner' && (
          <Button
            small
            disabled={busy}
            onClick={async () => {
              // The office answers with what it did, or with why it could not: that message is shown as it is.
              if ((await run(step.run, 'Undone')) !== undefined) setUndone(true);
            }}
          >
            Undo
          </Button>
        )}
        {step && (step.done || undone) && <Badge tone="muted">undone</Badge>}
      </div>
      <div className="row row-wrap small">
        <span className="faint" title={stamp(e.ts)}>
          {timeAgo(e.ts)}
        </span>
        {reversal && <Badge tone="warn">a change taken back</Badge>}
        {about && <Badge tone="neutral">{about}</Badge>}
        {evidence.slice(0, 6).map((ev, i) => (
          <EvidenceChip key={i} ev={{ kind: ev.kind as EvidenceRef['kind'], id: String(ev.id), note: text(ev.note) ?? '' }} />
        ))}
      </div>
    </div>
  );
}

function DoneByItself() {
  const live = useOffice((s) => s.events);
  const dial = useOffice((s) => s.settings?.selfImprovement.autopilot);
  const enabled = useOffice((s) => s.settings?.selfImprovement.enabled ?? false);
  const [older, setOlder] = useState<OrchestratorEvent[]>([]);
  useEffect(() => {
    let on = true;
    // The office keeps the whole log; what arrives live while the window is open is added to it below.
    api<OrchestratorEvent[]>('GET', '/growth/log')
      .then((log) => on && setOlder(Array.isArray(log) ? log : []))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, []);
  const seen = new Set<string>();
  // What the office did, not its bookkeeping: which lessons each prompt carried, and "nothing to learn", are left out.
  const BOOKKEEPING = new Set(['learning.lessons_delivered', 'learning.nothing_to_learn', 'learning.proven', 'learning.unproven', 'learning.failure_seen_again']);
  const log = [...live.filter((e) => String(e.type).startsWith('learning.')), ...older]
    .filter((e) => !BOOKKEEPING.has(String(e.type)) && !seen.has(e.id) && !!seen.add(e.id))
    .sort((a, b) => b.ts.localeCompare(a.ts));
  // Merges and promotions that were taken back say which event they reverse.
  const reverted = new Set(log.map((e) => text(e.data?.revertedEvent)).filter((x): x is string => !!x));
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="small muted">Everything the office changed by itself because of what it learned, newest first. Each entry says why, and can be undone.</div>
      {log.length === 0 ? (
        <Empty title="The office has done nothing by itself">
          {!enabled ? 'Learning is switched off.' : dial === 'off' ? 'It is set to ask you first, so nothing will appear here.' : 'When it applies something it learned, it is listed here with the reason and an Undo.'}
        </Empty>
      ) : (
        log.map((e) => <LogRow key={e.id} e={e} reverted={reverted} />)
      )}
    </div>
  );
}

// ─────────────────────────── what the team knows ───────────────────────────

const STATUS_RANK: Record<Lesson['status'], number> = { proposed: 0, active: 1, retired: 2 };
const lessonOrder = (a: Lesson, b: Lesson): number => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.createdAt.localeCompare(a.createdAt);

/**
 * The numbers the office keeps on a lesson. `appliedCount` is always there; the others are shown when
 * the lesson record carries them (how often it was used, when last, and whether the record since bears it out).
 */
function lessonNumbers(lesson: Lesson): { included: number; lastUsed: string | null; verdict: { label: string; tone: Tone; title?: string } | null } {
  const lastUsed = lesson.playbook?.lastIncludedAt ?? null;
  const verdict = lesson.proven
    ? { label: 'shown to help', tone: 'good' as Tone, title: 'Tasks that were given this lesson went measurably better than comparable tasks without it' }
    : lesson.outcomesRetired && lesson.status === 'retired'
      ? { label: lesson.outcomesRetired.verdict === 'harmful' ? 'retired: made things worse' : 'retired: did not help', tone: 'bad' as Tone, title: lesson.outcomesRetired.why }
      : (lesson.captureMustInclude ?? 0) > 0
        ? { label: 'asked about again', tone: 'warn' as Tone, title: 'The office knew this and was asked the same thing again: it now puts this lesson first' }
        : null;
  return { included: lesson.appliedCount, lastUsed, verdict };
}

function LessonRow({ lesson }: { lesson: Lesson }) {
  const [busy, run] = useAction();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(lesson.text);
  const [when, setWhen] = useState(lesson.appliesWhen);
  const source = SOURCE[lesson.source] ?? { label: String(lesson.source), tone: 'muted' as Tone, title: '' };
  const numbers = lessonNumbers(lesson);
  const setStatus = (status: Lesson['status'], ok: string) => run(() => api('PATCH', `/lessons/${lesson.id}`, { status }), ok);
  const edit = () => {
    setBody(lesson.text);
    setWhen(lesson.appliesWhen);
    setEditing(true);
  };
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    if (body.trim().length < 8 || busy) return;
    const res = await run(() => api('PATCH', `/lessons/${lesson.id}`, { text: body, appliesWhen: when }), 'Lesson updated');
    if (res) setEditing(false);
  };
  return (
    <div className={`card col ${lesson.status === 'retired' ? 'pw-dim' : ''}`}>
      {editing ? (
        <form className="col" onSubmit={save}>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} aria-label="Lesson" style={{ minHeight: 56 }} autoFocus />
          <input value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Applies when" placeholder="Applies when… (optional)" />
          <div className="row">
            <Button small variant="primary" type="submit" disabled={busy || body.trim().length < 8}>
              Save
            </Button>
            <Button small variant="ghost" type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            {body.trim().length < 8 && <span className="small muted">A lesson needs to be a full sentence.</span>}
          </div>
        </form>
      ) : (
        <div>
          <div className="pre">{lesson.text}</div>
          {lesson.appliesWhen && <div className="small muted">Applies: {lesson.appliesWhen}</div>}
        </div>
      )}
      <div className="row row-wrap small">
        {lesson.status !== 'active' && <Badge tone={lesson.status === 'proposed' ? 'warn' : 'muted'}>{lesson.status === 'proposed' ? 'waiting for you' : 'not used'}</Badge>}
        <Badge tone={source.tone} title={source.title}>
          {source.label}
        </Badge>
        {numbers.verdict && (
          <Badge tone={numbers.verdict.tone} title={numbers.verdict.title ?? 'What the recorded work since says about this lesson'}>
            {numbers.verdict.label}
          </Badge>
        )}
        <span className="muted" title="Counted: how many task prompts the office has put this lesson into">
          in {plural(numbers.included, 'prompt')}
          {numbers.lastUsed ? ` · last ${timeAgo(numbers.lastUsed)}` : ''} · by {lesson.authoredBy.name}, {timeAgo(lesson.createdAt)}
        </span>
        {lesson.evidence.map((ev, i) => (
          <EvidenceChip key={i} ev={ev} />
        ))}
        <div className="grow" />
        {lesson.status === 'proposed' && (
          <>
            <Button small variant="success" disabled={busy} onClick={() => setStatus('active', 'Lesson approved: it is used from now on')}>
              Approve
            </Button>
            <Button small disabled={busy} onClick={() => setStatus('retired', 'Lesson not used; kept for the record')}>
              Reject
            </Button>
          </>
        )}
        {lesson.status === 'active' && (
          <Button small variant="ghost" disabled={busy} onClick={() => setStatus('retired', 'Lesson retired: no longer used in prompts')}>
            Retire
          </Button>
        )}
        {lesson.status === 'retired' && (
          <Button small variant="ghost" disabled={busy} onClick={() => setStatus('active', 'Lesson is used again')}>
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
  if (!done.length || !since) return null;
  return (
    <span className="small muted" title={`Counted from the task records; first lesson ${stamp(since)}. Not proof that the lessons caused any difference.`}>
      passed first time — before the first lesson: <span className="mono strong">{tally(done.filter((t) => t.completedAt < since))}</span> · since: <span className="mono strong">{tally(done.filter((t) => t.completedAt >= since))}</span>
    </span>
  );
}

function AddLesson({ onDone }: { onDone: () => void }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const employees = activeEmployees(s.employees);
  const projects = Object.values(s.projects)
    .filter((p) => p.status !== 'archived')
    .sort((a, b) => a.name.localeCompare(b.name));
  const [scope, setScope] = useState<Lesson['scope']>('employee');
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '');
  const [projectId, setProjectId] = useState(s.filter.projectId ?? projects[0]?.id ?? '');
  const [body, setBody] = useState('');
  const [when, setWhen] = useState('');
  const target = scope === 'employee' ? employeeId : scope === 'project' ? projectId : 'company';
  const ready = body.trim().length >= 8 && !!target;
  const enabled = s.settings?.selfImprovement.enabled ?? false;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!ready || busy) return;
    const lesson = await run(() => api<Lesson>('POST', '/lessons', { text: body, appliesWhen: when, scope, ...(scope === 'employee' ? { employeeId } : scope === 'project' ? { projectId } : {}) }));
    if (lesson) {
      s.toast(enabled ? 'Lesson added: it is used in prompts from now on' : 'Lesson added. It is not used while learning is switched off', 'success');
      onDone();
    }
  };

  return (
    <form className="card pw-form" onSubmit={submit}>
      <div className="small muted field-wide">Tell your team something once. It is used immediately: added, in your words, to the task prompts of whoever it is for.</div>
      <Field label="Who is it for">
        <select value={scope} onChange={(e) => setScope(e.target.value as Lesson['scope'])}>
          <option value="employee">One employee</option>
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
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Always run the migration check before touching the schema." autoFocus />
      </Field>
      <Field label="Applies when (optional)" wide>
        <input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="when changing an API contract" />
      </Field>
      <div className="row field-wide">
        <Button variant="primary" type="submit" disabled={busy || !ready}>
          Add
        </Button>
        <Button variant="ghost" type="button" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Group({ title, sub, lead, children }: { title: ReactNode; sub?: ReactNode; lead?: ReactNode; children: ReactNode }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row">
        {lead}
        <div className="grow">
          <div className="strong">{title}</div>
          {sub && <div className="small muted">{sub}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

function TeamKnows() {
  const s = useOffice();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const owner = (l: Lesson) => (l.scope === 'employee' ? (s.employees[l.employeeId ?? '']?.name ?? '') : l.scope === 'project' ? (s.projects[l.projectId ?? '']?.name ?? '') : 'company');
  const all = Object.values(s.lessons);
  const lessons = all.filter((l) => words.every((w) => `${l.text} ${l.appliesWhen} ${owner(l)} ${l.authoredBy.name}`.toLowerCase().includes(w))).sort(lessonOrder);
  const by = (scope: Lesson['scope'], key: (l: Lesson) => string | null) => {
    const groups = new Map<string, Lesson[]>();
    for (const l of lessons) if (l.scope === scope) groups.set(key(l) ?? '', [...(groups.get(key(l) ?? '') ?? []), l]);
    return [...groups.entries()];
  };
  const people = by('employee', (l) => l.employeeId).sort((a, b) => (s.employees[a[0]]?.name ?? '').localeCompare(s.employees[b[0]]?.name ?? ''));
  const projects = by('project', (l) => l.projectId).sort((a, b) => (s.projects[a[0]]?.name ?? '').localeCompare(s.projects[b[0]]?.name ?? ''));
  const company = lessons.filter((l) => l.scope === 'company');
  const used = (list: Lesson[]) => plural(list.filter((l) => l.status === 'active').length, 'lesson') + ' in use';
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row">
        <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search lessons" placeholder={`Search ${plural(all.length, 'lesson')}…`} />
        <Button variant={adding ? 'default' : 'primary'} onClick={() => setAdding(!adding)}>
          Add a lesson
        </Button>
      </div>
      {adding && <AddLesson onDone={() => setAdding(false)} />}
      <div className="small muted">Lessons are added to task prompts: a person's own to theirs, a project's to everyone on it, the company's to everyone. Each one cites where it came from.</div>
      {all.length === 0 && <Empty title="Nothing learned yet">Lessons come from three places: an employee writes one after a task that went wrong, an answer you give to a question is kept, or you add one here.</Empty>}
      {all.length > 0 && lessons.length === 0 && <Empty title="No lesson matches">Nothing mentions “{query}”.</Empty>}
      {people.length > 0 && <div className="section-title">People</div>}
      {people.map(([id, list]) => {
        const e = s.employees[id];
        return (
          <Group
            key={id}
            title={e?.name ?? 'Someone who no longer works here'}
            sub={
              <>
                {e ? `${e.title} · ` : ''}
                {used(list)}
                {e && (
                  <>
                    {' · '}
                    <BeforeAfter employeeId={id} lessons={list} />
                  </>
                )}
              </>
            }
            lead={e && <Avatar appearance={e.appearance} size={32} />}
          >
            {list.map((l) => (
              <LessonRow key={l.id} lesson={l} />
            ))}
          </Group>
        );
      })}
      {projects.length > 0 && <div className="section-title">Projects</div>}
      {projects.map(([id, list]) => (
        <Group key={id} title={s.projects[id]?.name ?? 'A project that no longer exists'} sub={used(list)}>
          {list.map((l) => (
            <LessonRow key={l.id} lesson={l} />
          ))}
        </Group>
      ))}
      {company.length > 0 && <div className="section-title">Company</div>}
      {company.length > 0 && (
        <Group title="Everyone" sub={used(company)}>
          {company.map((l) => (
            <LessonRow key={l.id} lesson={l} />
          ))}
        </Group>
      )}
    </div>
  );
}

// ─────────────────────────────── results ───────────────────────────────

const pct = (v: number | null): string => (v == null ? '—' : `${Math.round(v * 100)}%`);
const num = (v: number | null): string => (v == null ? '—' : `${Math.round(v * 100) / 100}`);

/** Whether what was learned is paying off, as the office measures it from finished tasks. */
function Outcomes() {
  const [report, setReport] = useState<OutcomesReport | null>(null);
  useEffect(() => {
    let on = true;
    api<OutcomesReport>('GET', '/growth/outcomes')
      .then((r) => on && setReport(r))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, []);
  if (!report || report.tasks === 0) return null;
  const { last, previous, window } = report.trends.recent;
  // Higher is better for the first; lower for the rest.
  const rows: Array<{ label: string; before: string; after: string; better: boolean | null }> = [
    { label: 'Done right the first time', before: pct(previous.firstPassRate), after: pct(last.firstPassRate), better: previous.firstPassRate == null || last.firstPassRate == null || previous.firstPassRate === last.firstPassRate ? null : last.firstPassRate > previous.firstPassRate },
    { label: 'Trouble per task', before: num(previous.meanFriction), after: num(last.meanFriction), better: previous.meanFriction == null || last.meanFriction == null || previous.meanFriction === last.meanFriction ? null : last.meanFriction < previous.meanFriction },
    { label: 'Questions per task', before: num(previous.questionsPerTask), after: num(last.questionsPerTask), better: previous.questionsPerTask == null || last.questionsPerTask == null || previous.questionsPerTask === last.questionsPerTask ? null : last.questionsPerTask < previous.questionsPerTask },
    { label: 'Permissions asked per task', before: num(previous.approvalsPerTask), after: num(last.approvalsPerTask), better: previous.approvalsPerTask == null || last.approvalsPerTask == null || previous.approvalsPerTask === last.approvalsPerTask ? null : last.approvalsPerTask < previous.approvalsPerTask },
  ];
  const judged = report.lessons.filter((l) => l.verdict !== 'no_effect_yet');
  const changes = report.improvements;
  return (
    <div className="col" style={{ gap: 10 }}>
      <div>
        <div className="section-title">Is it getting better?</div>
        {previous.tasks === 0 ? (
          <div className="small muted">
            {report.tasks} finished task{report.tasks === 1 ? '' : 's'} so far: {pct(report.trends.overall.firstPassRate)} done right the first time. A comparison appears after {window * 2} tasks.
          </div>
        ) : (
          <>
            <div className="small muted">
              The last {last.tasks} finished tasks against the {previous.tasks} before them.
            </div>
            <table className="tbl">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                      {r.before} → {r.after}
                    </td>
                    <td style={{ width: 1 }}>{r.better !== null && <Badge tone={r.better ? 'good' : 'bad'}>{r.better ? 'better' : 'worse'}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
      {(judged.length > 0 || changes.length > 0) && (
        <div>
          <div className="section-title">Did what it learned help?</div>
          <div className="col" style={{ gap: 4 }}>
            {judged.map((l) => (
              <div key={l.lessonId} className="row small" style={{ alignItems: 'flex-start', gap: 8 }}>
                <Badge tone={l.verdict === 'helping' ? 'good' : l.verdict === 'harmful' ? 'bad' : 'muted'}>{l.verdict === 'helping' ? 'helps' : l.verdict === 'harmful' ? 'hurts' : 'no difference'}</Badge>
                <span className="grow">
                  <span className="strong">“{l.text.length > 110 ? `${l.text.slice(0, 110)}…` : l.text}”</span>
                  <span className="muted"> — {l.line}</span>
                </span>
              </div>
            ))}
            {changes.map((c) => (
              <div key={c.improvementId} className="row small" style={{ alignItems: 'flex-start', gap: 8 }}>
                <Badge tone={c.verdict === 'helping' ? 'good' : c.verdict === 'harmful' ? 'bad' : 'muted'}>{c.verdict === 'helping' ? 'helped' : c.verdict === 'harmful' ? 'made it worse' : c.verdict === 'not_helping' ? 'no difference' : 'too early'}</Badge>
                <span className="grow">
                  <span className="strong">{c.title}</span>
                  <span className="muted"> — {c.line}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Results() {
  const s = useOffice();
  const si = s.settings?.selfImprovement;
  const routing = !!si?.enabled && si.learnedRouting;
  const rows = [...s.performance].sort((a, b) => (s.employees[a.employeeId]?.name ?? '').localeCompare(s.employees[b.employeeId]?.name ?? '') || a.kind.localeCompare(b.kind));
  const preferences = Object.values(s.projects).flatMap((p) => Object.entries(p.detectRouting ?? {}).map(([kind, id]) => `${kind} tasks in ${p.name} go to ${s.employees[id ?? '']?.name ?? 'someone who no longer works here'} first`));
  return (
    <div className="col" style={{ gap: 12 }}>
      <Outcomes />
      <div className="section-title">Who delivers what</div>
      <div className="small muted">
        Counted from the task records. “First time” means no failed verification and no review that sent it back.{' '}
        {routing ? 'Among equally suitable people, the better first-time record gets the task, once they have completed two of that kind.' : 'Learned routing is switched off in Settings, so these counts do not decide who gets a task.'}
        {routing && preferences.length > 0 && ` Preferences you accepted: ${preferences.join('; ')}.`}
      </div>
      {rows.length === 0 ? (
        <Empty title="No results yet">Rows appear when employees complete tasks.</Empty>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Kind of task</th>
              <th>Completed</th>
              <th>First time</th>
              <th>Failed verifications</th>
              <th>Sent back by review</th>
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
                  <td>{r.completed >= 2 ? routing && <Badge tone="info">counts for routing</Badge> : <span className="small faint">too few to count</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─────────────────────────────── panel ───────────────────────────────

const TABS = ['waiting', 'done', 'knowledge', 'results'] as const;
type GrowthTab = (typeof TABS)[number];
/** Names the tabs had before, so that anything that still opens Growth on one of them lands in the right place. */
const OLD_TABS: Record<string, GrowthTab> = { suggestions: 'waiting', playbooks: 'knowledge', teach: 'knowledge', record: 'results' };

/** arg: optionally the tab to open on. */
function GrowthPanel({ arg, onClose }: PanelProps) {
  const s = useOffice();
  const [tab, setTab] = useState<GrowthTab>(() => TABS.find((t) => t === arg) ?? OLD_TABS[arg ?? ''] ?? 'waiting');
  const waiting = Object.values(s.improvements).filter((i) => i.status === 'proposed').length + Object.values(s.lessons).filter((l) => l.status === 'proposed').length;
  return (
    <Window title="Growth" subtitle="What the office learns from its own work, and what it does with it" onClose={onClose} width={1120} flush>
      <div className="pw-frame">
        <AutopilotDial />
        <Tabs<GrowthTab>
          tabs={[
            { id: 'waiting', label: 'Waiting for you', count: waiting },
            { id: 'done', label: 'Done by itself' },
            { id: 'knowledge', label: 'What the team knows' },
            { id: 'results', label: 'Results' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="pw-body">
          {tab === 'waiting' && <WaitingForYou />}
          {tab === 'done' && <DoneByItself />}
          {tab === 'knowledge' && <TeamKnows />}
          {tab === 'results' && <Results />}
        </div>
      </div>
    </Window>
  );
}

registerPanel('growth', GrowthPanel);
