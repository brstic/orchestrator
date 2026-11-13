import { useState, type FormEvent } from 'react';
import type { Employee, Meeting, MeetingContribution, MeetingStatus } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Field, Markdown, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { ask } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { TaskChip, activeEmployees, stamp, useAction } from './tasks.tsx';
import './panels-work.css';

type PanelProps = { arg: string | null; onClose: () => void };
type Round = MeetingContribution['round'];

const NEW = 'new';
const STATUS_TONE: Record<MeetingStatus, Tone> = { scheduled: 'muted', proposals: 'info', responses: 'info', synthesis: 'info', concluded: 'good', cancelled: 'muted' };
const ROUNDS: Array<{ status: MeetingStatus; round: Round; label: string; explain: string }> = [
  { status: 'proposals', round: 'proposal', label: 'Proposals', explain: 'Every participant is asked for a proposal' },
  { status: 'responses', round: 'response', label: 'Responses', explain: "Each one answers the others' proposals" },
  { status: 'synthesis', round: 'synthesis', label: 'Synthesis', explain: 'The facilitator writes the decision document' },
];

const isActive = (m: Meeting) => m.status === 'proposals' || m.status === 'responses' || m.status === 'synthesis';

/**
 * Same rule the server uses: someone takes part through a running session, or through one the office put to
 * sleep — that one is woken for the meeting. Someone who was never started, or whom a person stopped, is absent.
 */
function useLive(): (employeeId: string) => boolean {
  const sessions = useOffice((s) => s.sessions);
  return (employeeId) => {
    const session = sessionOfEmployee(sessions, employeeId);
    return session?.status === 'running' || session?.status === 'starting' || !!session?.asleepSince;
  };
}

// ──────────────────────────── new meeting ────────────────────────────

function MeetingCreate({ onCreated }: { onCreated: (id: string) => void }) {
  const s = useOffice();
  const live = useLive();
  const [busy, run] = useAction();
  const employees = activeEmployees(s.employees);
  const projects = Object.values(s.projects)
    .filter((p) => p.status !== 'archived')
    .sort((a, b) => a.name.localeCompare(b.name));
  const [topic, setTopic] = useState('');
  const [context, setContext] = useState('');
  const [projectId, setProjectId] = useState(s.filter.projectId ?? '');
  const [picked, setPicked] = useState<string[]>([]);
  const [facilitatorId, setFacilitatorId] = useState('');
  const [more, setMore] = useState(false);

  const present = picked.filter(live);
  const facilitators = employees.filter((e) => present.includes(e.id));
  const problem = picked.length < 2 ? 'Pick at least two participants.' : present.length === 0 ? 'None of the people you picked can take part: start at least one of them first.' : null;
  const toggle = (id: string, on: boolean) => {
    setPicked(on ? [...picked, id] : picked.filter((x) => x !== id));
    if (!on && facilitatorId === id) setFacilitatorId('');
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!topic.trim() || problem || busy) return;
    const meeting = await run(() => api<Meeting>('POST', '/meetings', { topic, context, projectId: projectId || null, participantIds: picked, facilitatorId: facilitatorId || null }));
    if (meeting) {
      s.toast(`Meeting started: the proposal round went out to ${meeting.participantIds.length - meeting.absent.length} sessions`, 'success');
      onCreated(meeting.id);
    }
  };

  return (
    <form className="pw-form" onSubmit={submit}>
      <div className="field-wide">
        <div className="strong" style={{ fontSize: 15 }}>
          New meeting
        </div>
        <div className="small muted">Each person you pick is asked for a proposal, then for a response to the others; the facilitator writes the decision. </div>
      </div>
      <Field label="Topic" wide>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What needs to be decided" autoFocus required />
      </Field>
      <Field label="Context" hint="Sent to every participant with the topic." wide>
        <textarea value={context} onChange={(e) => setContext(e.target.value)} placeholder="Background, constraints, what a good outcome looks like." />
      </Field>
      <div className="field field-wide">
        <span className="row spread">
          <span className="field-label">
            Participants ({picked.length} picked, {present.length} who can take part)
          </span>
          <Button small type="button" variant="ghost" onClick={() => setPicked(employees.filter((e) => live(e.id)).map((e) => e.id))}>
            Pick everyone who can take part
          </Button>
        </span>
        {employees.length === 0 ? (
          <span className="field-hint">There are no employees yet.</span>
        ) : (
          <div className="pw-picklist" style={{ maxHeight: 260 }}>
            {employees.map((e) => (
              <label key={e.id} className="check" style={{ alignItems: 'center' }}>
                <input type="checkbox" style={{ margin: 0 }} checked={picked.includes(e.id)} onChange={(ev) => toggle(e.id, ev.target.checked)} />
                <Avatar appearance={e.appearance} size={24} offline={!live(e.id)} />
                <span className="grow truncate">
                  {e.name} <span className="muted small">{e.title}</span>
                </span>
                {!live(e.id) && (
                  <Badge tone="warn" title="They were never started, or someone stopped them. Invited anyway, they are recorded as absent. Start them first to have them take part.">
                    not started — would be absent
                  </Badge>
                )}
              </label>
            ))}
          </div>
        )}
      </div>
      {/* Both have a sensible answer by themselves, so they stay folded until wanted. */}
      <details className="pc-more field-wide" open={more} onToggle={(ev) => setMore((ev.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          More options: project, facilitator
          {!more && (projectId || facilitatorId) && (
            <span className="small faint"> — {[projectId ? s.projects[projectId]?.name : '', facilitatorId ? `facilitated by ${s.employees[facilitatorId]?.name}` : ''].filter(Boolean).join(' · ')}</span>
          )}
        </summary>
        <div className="pw-form" style={{ marginTop: 10 }}>
          <Field label="Project" hint="Follow-up tasks from the decision are created in this project.">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">The facilitator's project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Facilitator" hint="Writes the decision in the last round.">
            <select value={facilitatorId} onChange={(e) => setFacilitatorId(e.target.value)}>
              <option value="">Automatic (architect, then project manager, then anyone present)</option>
              {facilitators.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </details>
      <div className="row field-wide">
        <Button variant="primary" type="submit" disabled={busy || !topic.trim() || !!problem}>
          Start meeting
        </Button>
        {problem && <span className="small muted">{problem}</span>}
      </div>
    </form>
  );
}

// ───────────────────────────── a meeting ─────────────────────────────

function Steps({ meeting }: { meeting: Meeting }) {
  const at = ROUNDS.findIndex((r) => r.status === meeting.status);
  return (
    <div className="pw-steps">
      {ROUNDS.map((r, i) => {
        const count = meeting.contributions.filter((c) => c.round === r.round).length;
        const cls = i === at ? 'pw-step-on' : count > 0 ? 'pw-step-done' : '';
        return (
          <span key={r.status} className="row" style={{ gap: 6 }}>
            <span className={`pw-step ${cls}`} title={i !== at && count === 0 && !isActive(meeting) ? `${r.explain}. Nothing was received in this round.` : r.explain}>
              {r.label}
              {count > 0 ? ` · ${count}` : ''}
            </span>
            <span className="faint">→</span>
          </span>
        );
      })}
      <span className={`pw-step ${meeting.status === 'concluded' ? 'pw-step-done' : ''}`}>Concluded</span>
      {meeting.status === 'cancelled' && <Badge tone="bad">cancelled</Badge>}
    </div>
  );
}

function Contribution({ c, author, showBody = true }: { c: MeetingContribution; author: Employee | undefined; showBody?: boolean }) {
  return (
    <div className="card col">
      <div className="row">
        {author && <Avatar appearance={author.appearance} size={26} />}
        <span className="strong">{author?.name ?? 'Unknown employee'}</span>
        {author && <span className="small muted truncate grow">{author.title}</span>}
        <span className="small faint mono" style={{ marginLeft: 'auto' }}>
          {stamp(c.ts)}
        </span>
      </div>
      {showBody ? <Markdown text={c.body} /> : <div className="small muted">Their text is the decision document below.</div>}
      {c.disagreements.length > 0 && (
        <div>
          <div className="small strong" style={{ color: '#ffd27a' }}>
            Disagreements they recorded
          </div>
          <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {c.disagreements.map((d, i) => (
              <li key={i} className="pre">
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MeetingDetail({ meeting }: { meeting: Meeting }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const active = isActive(meeting);
  const project = meeting.projectId ? s.projects[meeting.projectId] : undefined;
  const facilitator = s.employees[meeting.facilitatorId];
  const present = meeting.participantIds.filter((id) => !meeting.absent.includes(id));
  const current = ROUNDS.find((r) => r.status === meeting.status);
  // Who the current round is still waiting for: derived from the record, exactly as the server does.
  const waiting = !current ? [] : current.round === 'synthesis' ? [meeting.facilitatorId] : present.filter((id) => !meeting.contributions.some((c) => c.employeeId === id && c.round === current.round));
  const synthesised = meeting.contributions.some((c) => c.round === 'synthesis');
  const names = (ids: string[]) => ids.map((id) => s.employees[id]?.name ?? 'unknown').join(', ');

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row spread" style={{ alignItems: 'flex-start' }}>
        <div className="col" style={{ gap: 4, minWidth: 0 }}>
          <div className="strong" style={{ fontSize: 16 }}>
            {meeting.topic}
          </div>
          <div className="small muted">
            started {stamp(meeting.createdAt)}
            {meeting.concludedAt ? ` · ended ${stamp(meeting.concludedAt)}` : ''}
            {project ? ` · ${project.name}` : ''}
          </div>
        </div>
        {active && (
          <Button
            variant="danger"
            small
            disabled={busy}
            onClick={() => void ask({ title: 'Cancel this meeting?', body: `"${meeting.topic}"\n\nNobody is asked any more. What was already said stays on record; no decision is written.`, ok: 'Cancel meeting', danger: true }).then((yes) => { if (yes) void run(() => api('POST', `/meetings/${meeting.id}/cancel`, {}), 'Meeting cancelled'); })}
          >
            Cancel meeting
          </Button>
        )}
      </div>

      <div className="col" style={{ gap: 6 }}>
        <div className="row row-wrap">
          <Badge tone={STATUS_TONE[meeting.status]}>{meeting.status}</Badge>
          <Steps meeting={meeting} />
        </div>
        {current && (
          <div className="small muted">
            {current.explain}. Round started {timeAgo(meeting.roundStartedAt)}
            {waiting.length ? ` · waiting for ${names(waiting)}` : ''}. Anyone who does not answer in time is recorded as absent.
          </div>
        )}
      </div>

      <div className="pw-note">Written by the employees themselves, each in their own session. Anyone who did not answer is marked absent.</div>

      {meeting.context && (
        <div>
          <div className="section-title">Context given to the participants</div>
          <div className="pre">{meeting.context}</div>
        </div>
      )}

      <div>
        <div className="section-title">
          Participants ({present.length} of {meeting.participantIds.length} took part)
        </div>
        <div className="row row-wrap" style={{ gap: 14 }}>
          {meeting.participantIds.map((id) => {
            const e = s.employees[id];
            const absent = meeting.absent.includes(id);
            return (
              <span key={id} className={`row ${absent ? 'pw-dim' : ''}`} style={{ gap: 6 }}>
                {e && <Avatar appearance={e.appearance} size={30} offline={absent} />}
                <span className="col" style={{ gap: 0 }}>
                  <span className="strong">{e?.name ?? 'Unknown employee'}</span>
                  <span className="small muted">{absent ? 'did not take part' : id === meeting.facilitatorId ? 'facilitator' : (e?.title ?? '')}</span>
                </span>
              </span>
            );
          })}
        </div>
        {!meeting.participantIds.includes(meeting.facilitatorId) && <div className="small muted" style={{ marginTop: 6 }}>Facilitator: {facilitator?.name ?? 'unknown'}</div>}
      </div>

      {ROUNDS.map((r) => {
        const items = meeting.contributions.filter((c) => c.round === r.round);
        if (!items.length) return null;
        return (
          <div key={r.round}>
            <div className="section-title">
              {r.label} ({items.length})
            </div>
            <div className="col">
              {items.map((c) => (
                <Contribution key={c.id} c={c} author={s.employees[c.employeeId]} showBody={r.round !== 'synthesis' || !meeting.decisionDoc} />
              ))}
            </div>
          </div>
        );
      })}
      {meeting.contributions.length === 0 && <div className="muted">{active ? 'No contribution has been received yet.' : 'No contribution was received.'}</div>}

      {meeting.decisionDoc && (
        <div>
          <div className="section-title row" style={{ gap: 8 }}>
            {synthesised ? 'Decision document' : 'Meeting record — no decision was written'}
            <Badge tone={synthesised ? 'good' : 'warn'}>{synthesised ? `written by ${facilitator?.name ?? 'the facilitator'}` : 'not synthesised'}</Badge>
          </div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            {synthesised
              ? 'The decision is the facilitator session\'s own text. Orchestrator added only the header (date, participants) and the list of recorded disagreements.'
              : 'The facilitator did not conclude in time, so Orchestrator stored the unedited contributions as the record.'}
          </div>
          <div className="pw-doc"><Markdown text={meeting.decisionDoc} /></div>
        </div>
      )}

      {meeting.generatedTaskIds.length > 0 && (
        <div>
          <div className="section-title">Tasks created from the decision ({meeting.generatedTaskIds.length})</div>
          <div className="row row-wrap">
            {meeting.generatedTaskIds.map((id) => (
              <TaskChip key={id} id={id} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── panel ───────────────────────────────

/** arg: a meeting id to preselect. */
function MeetingsPanel({ arg, onClose }: PanelProps) {
  const s = useOffice();
  const meetings = Object.values(s.meetings).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [selected, setSelected] = useState(() => (arg && s.meetings[arg] ? arg : (meetings[0]?.id ?? NEW)));
  const meeting = s.meetings[selected];
  return (
    <Window kit title="Meetings" subtitle="Put a question to several employees and get one decision" onClose={onClose} width={1120} flush>
      <div className="pw-frame">
        <div className="split">
          <div className="split-side col">
            <Button variant={selected === NEW ? 'primary' : 'default'} onClick={() => setSelected(NEW)}>
              New meeting
            </Button>
            <div className="list">
              {meetings.map((m) => (
                <button key={m.id} type="button" className={`list-item pw-list-btn ${selected === m.id ? 'list-item-on' : ''}`} onClick={() => setSelected(m.id)}>
                  <span className="grow col" style={{ gap: 0 }}>
                    <span className="strong truncate">{m.topic}</span>
                    <span className="small muted">
                      {m.participantIds.length} participants · {timeAgo(m.createdAt)}
                    </span>
                  </span>
                  <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>
                </button>
              ))}
              {meetings.length === 0 && <div className="small muted">No meetings yet.</div>}
            </div>
          </div>
          <div className="split-main">{meeting ? <MeetingDetail key={meeting.id} meeting={meeting} /> : selected === NEW ? <MeetingCreate onCreated={setSelected} /> : <Empty title="This meeting is no longer available" />}</div>
        </div>
      </div>
    </Window>
  );
}

registerPanel('meetings', MeetingsPanel);
