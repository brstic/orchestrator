import { DeskPicker, WherePicker, useHirePlaces, type HirePlace } from './hire-where.tsx';
import { BulkHire } from './bulk-hire.tsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSession, Appearance, AutonomyLevel, CommunicationStyle, DeliveryStatus, Employee, ExecutionMode, Host, OrchestratorEvent, XpEntry } from '@orchestrator/contracts';
import { DESK_SIZE, EFFORT_CHOICES, MODEL_CHOICES, ROLE_CATALOGUE, memberSeatOf, roleByKey } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Field, Progress, Provenance, Stat, Tabs, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { api, connection } from '../../lib/api.ts';
import { activityOf, currentTaskOf, openQuestionsOf, sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { useAccess } from '../../lib/access.ts';
import { mayKeep, scoped, whoseEmployee, whoseLabel } from '../../lib/mine.ts';
import { byAttention, employeeState } from '../../lib/my-work.ts';
import { byProject, levelLine, teamLine } from '../../lib/team.ts';
import { byDay, oneLine } from '../../lib/inbox.ts';
import { More, State } from './kit.tsx';
import { ScopeSwitch, WhoseBadge, useScope } from '../mine.tsx';
import { FolderField } from './folder-picker.tsx';
import { registerPanel } from './index.tsx';
import {
  ActivityBadge,
  CONTROL_STATES,
  CapabilityBadges,
  ConfirmBox,
  HostLabel,
  LoadState,
  NOT_AVAILABLE,
  OfficeSvg,
  byName,
  eventTone,
  fmtDateTime,
  fmtInt,
  humanize,
  initials,
  isLive,
  isLoudEvent,
  isWorking,
  levelInfo,
  occupantsByDesk,
  onActivate,
  runtimeLabel,
  useLoad,
  useUnlocked,
  type PanelProps,
} from './company-shared.tsx';

/** The worker runtime choice, with what the chosen machine can actually provide. */
function RuntimeField({ value, onChange, host }: { value: ExecutionMode; onChange: (v: ExecutionMode) => void; host: Host | undefined }) {
  const runtimes = host?.info?.runtimes;
  const sdkHere = !!runtimes?.includes('managed_sdk');
  const hint =
    value === 'managed_sdk'
      ? !host
        ? 'Driven through the Claude Agent SDK: prompts, approvals and interrupts are structured calls; the terminal shows a transcript.'
        : sdkHere
          ? `Driven through the Claude Agent SDK on ${host.name}: prompts, approvals and interrupts are structured calls; the terminal shows a transcript and still takes typed prompts.`
          : `${host.name} does not report the Agent SDK${runtimes ? '' : ' (its agent has not reported its runtimes yet)'}. Until it is installed there (orchestrator-agent sdk install), this employee starts as an interactive worker and the office says so.`
      : 'The real Claude Code terminal UI in tmux. Messages are typed into it; approvals go through hooks.';
  return (
    <Field label="Runtime" hint={hint}>
      <select value={value} onChange={(ev) => onChange(ev.target.value as ExecutionMode)}>
        <option value="interactive_cli">Interactive Claude Code (terminal)</option>
        <option value="managed_sdk">SDK-managed (Claude Agent SDK){host && !sdkHere ? ' — not available on this machine' : ''}</option>
      </select>
    </Field>
  );
}

/** What each autonomy level really becomes when a session is launched. */
const AUTONOMY: Array<{ id: AutonomyLevel; label: string; text: string; maps: string; tone: Tone }> = [
  { id: 'restricted', label: 'Restricted', text: 'Read-only: can inspect and research; file edits are denied.', maps: 'Manual permission mode, edit tools denied, read-only commands pre-approved', tone: 'muted' },
  { id: 'supervised', label: 'Supervised', text: 'Every edit and every command needs your approval.', maps: 'Manual permission mode, nothing pre-approved', tone: 'info' },
  { id: 'standard', label: 'Standard', text: 'Edits and routine commands are allowed; everything else asks you.', maps: 'acceptEdits permission mode plus an allow-list of routine commands', tone: 'neutral' },
  { id: 'autonomous', label: 'Autonomous', text: 'Works end to end on its task; risky commands still ask you.', maps: 'acceptEdits permission mode plus a wider allow-list; high-risk commands always escalate', tone: 'accent' },
  { id: 'auto', label: 'Auto', text: 'Works on their own and asks you only for decisions and direction, not for permission.', maps: "Claude Code's auto permission mode: its own safety check decides what may run. High-risk commands (push, sudo, deploy…) still ask you unless you turn that off in Settings → Employees", tone: 'good' },
  { id: 'unrestricted', label: 'Unrestricted', text: 'Nothing is checked or asked by Claude Code: what they run, runs. Only the high-risk list (push, sudo, deploy, broad deletions…) and the project\'s deny rules still stand.', maps: "Claude Code's bypass-permissions mode. It protects against nothing — not a mistaken command, not an instruction hidden in a page or a ticket they read. The office still holds high-risk commands for your answer (Settings → Employees), and deny rules still apply. The first start on a Claude account asks you once to accept Claude Code's own warning. Owners only.", tone: 'bad' },
];

const HIRE_NAMES = ['Alex', 'Sarah', 'Mike', 'Emma', 'David', 'Ava', 'Noah', 'Mia', 'Leo', 'Zoe', 'Ivan', 'Nina', 'Omar', 'Lena', 'Theo', 'Ruth'];

const STYLES: CommunicationStyle[] = ['concise', 'analytical', 'cautious', 'experimental', 'detail-oriented', 'architecture-focused', 'highly-independent', 'review-focused'];

function autonomyInfo(level: AutonomyLevel) {
  return AUTONOMY.find((a) => a.id === level)!;
}

function AutonomyBadge({ level }: { level: AutonomyLevel }) {
  const a = autonomyInfo(level);
  return (
    <Badge tone={a.tone} title={`${a.text}\n${a.maps}`}>
      {a.label}
    </Badge>
  );
}

/**
 * How much an employee may do without asking: six levels, one line each; the chosen one says the rest (what it is
 * in Claude Code's own terms) under its line.
 */
function AutonomyPicker({ value, onChange, name }: { value: AutonomyLevel; onChange: (v: AutonomyLevel) => void; name: string }) {
  return (
    <div className="k-group" role="radiogroup" aria-label="Autonomy">
      {AUTONOMY.map((a) => (
        <label key={a.id} className={`k-pick ${value === a.id ? 'k-pick-on' : ''}`}>
          <input type="radio" name={name} checked={value === a.id} onChange={() => onChange(a.id)} />
          <span className="k-pick-words">
            <span>
              <span className="strong">{a.label}</span>
              <span className="k-pick-text"> — {a.text}</span>
            </span>
            {value === a.id && <span className="k-pick-more">{a.maps}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

function parseSkills(text: string): string[] {
  return text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function LevelCell({ e }: { e: Employee }) {
  const info = levelInfo(e.xp, e.level);
  return (
    <div className="pc-level" title="Level reflects verified delivered work, not model capability">
      <span className="small">
        <span className="strong">L{e.level}</span> <span className="muted">{info.next == null ? `${fmtInt(e.xp)} XP · top level` : `${fmtInt(e.xp)} / ${fmtInt(info.next)} XP`}</span>
      </span>
      <Progress value={info.pct} tone="accent" />
    </div>
  );
}

/**
 * Which model an employee's sessions run on, and how hard it works on each turn. Both start on "Default": what
 * Claude Code on their machine would use by itself. The levels offered are the ones that machine's Claude Code has.
 */
function ModelEffortFields({ model, effort, onModel, onEffort, host }: { model: string; effort: string; onModel: (v: string) => void; onEffort: (v: string) => void; host: Host | undefined }) {
  const [other, setOther] = useState(() => !!model && !MODEL_CHOICES.some((c) => c.value === model));
  // What that machine can do: its agent reports the levels of its Claude Code. No report: an agent from before this existed.
  const levels = host?.info ? (host.info.claudeEffortLevels ?? null) : undefined;
  const none = levels === null || (Array.isArray(levels) && levels.length === 0);
  const whyNone = levels === null ? `The Orchestrator app on ${host?.name ?? 'that machine'} is older and cannot set an effort yet; update it there.` : `Claude Code on ${host?.name ?? 'that machine'} has no effort setting yet; update it there to use this.`;
  return (
    <>
      <Field label="Model" hint={other ? "A model's full name, as Claude Code takes it." : undefined}>
        <select
          value={other ? 'other' : model}
          aria-label="Model"
          onChange={(ev) => {
            setOther(ev.target.value === 'other');
            onModel(ev.target.value === 'other' ? '' : ev.target.value);
          }}
        >
          <option value="">Default — what their Claude account uses</option>
          {MODEL_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label} — {c.what}
            </option>
          ))}
          <option value="other">Another model…</option>
        </select>
        {other && <input value={model} onChange={(ev) => onModel(ev.target.value)} className="mono" placeholder="the model's full name" spellCheck={false} aria-label="Model name" style={{ marginTop: 6 }} />}
      </Field>
      <Field label="Effort" hint={none ? whyNone : 'How hard it thinks on each turn. More is slower and uses more of the account.'}>
        <select value={effort} disabled={none} aria-label="Effort" onChange={(ev) => onEffort(ev.target.value)}>
          <option value="">Default</option>
          {EFFORT_CHOICES.filter((c) => !levels || levels.includes(c.value) || c.value === effort).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

// ───────────────────────────── Hire ─────────────────────────────

/**
 * `desk`: the desk the person was standing at when they chose to hire (it is preselected).
 * `self`: not an employee to give work to but the person's own Claude Code session at that desk — it is named
 * after them, started at once, and its terminal opens with the keyboard in their hands.
 */
function HireForm({ onDone, place, desk, self }: { onDone: (createdId?: string) => void; place: HirePlace; desk?: string; self?: boolean }) {
  const hostsById = useOffice((s) => s.hosts);
  const projectsById = useOffice((s) => s.projects);
  const hosts = useMemo(() => Object.values(hostsById).filter((h) => h.status !== 'revoked').sort(byName), [hostsById]);
  // Work stays on the machine its project is on: only projects that live where this employee will.
  const projects = useMemo(() => Object.values(projectsById).filter((p) => p.status !== 'archived' && (place.mine ? p.hostId === place.host.id : !hostsById[p.hostId ?? '']?.memberId)).sort(byName), [projectsById, place, hostsById]);
  const employeesNow = useOffice((st) => st.employees);
  const taken = new Set(Object.values(employeesNow).map((x) => x.name.toLowerCase()));
  // A name nobody here has yet, so the form can be submitted with just a folder.
  const myName = useOffice((st) => st.me?.name || st.settings?.ownerName || 'Me');
  const [name, setName] = useState(() => (self ? (taken.has(myName.toLowerCase()) ? `${myName} (me)` : myName) : (HIRE_NAMES.find((n) => !taken.has(n.toLowerCase())) ?? '')));
  const [more, setMore] = useState(false);
  const [roleKey, setRoleKey] = useState(ROLE_CATALOGUE.find((r) => r.key === 'fullstack')?.key ?? ROLE_CATALOGUE[0]!.key);
  const [title, setTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [specialization, setSpecialization] = useState('');
  const [skills, setSkills] = useState('');
  const hostId = place.host.id;
  // Which desk: null lets the office choose (with their project's people; in a room, the next free seat).
  const [deskId, setDeskId] = useState<string | null>(desk ?? null);
  const [projectId, setProjectId] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const can = useAccess();
  const [autonomy, setAutonomy] = useState<AutonomyLevel | null>(null);
  const [style, setStyle] = useState<CommunicationStyle>('concise');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('interactive_cli');
  const [instructions, setInstructions] = useState('');
  // Hiring gives someone a desk; their session starts when you first talk to them, give them a task, or press Start.
  const [startNow, setStartNow] = useState(!!self);
  const [busy, setBusy] = useState(false);

  const custom = roleKey === 'custom';
  const role = custom ? undefined : roleByKey(roleKey);
  const existingForeman = useOffice((s) => Object.values(s.employees).find((e) => !e.archived && e.roleKey === 'foreman'));
  // Default: they work on their own and come to the owner only for decisions.
  // The owner's default since 2026-11-11: everybody runs Unrestricted unless put back on Auto. It is an owner's to give; a colleague's hires start on Auto.
  const effectiveAutonomy = autonomy ?? (can.admin ? 'unrestricted' : 'auto');
  const host = hostId ? hostsById[hostId] : undefined;
  const project = projectId ? projectsById[projectId] : undefined;
  const hasCwd = !!workingDir.trim() || !!project?.repoPath;
  const canStart = !!host && host.status === 'online' && hasCwd;
  const valid = !!name.trim() && (!custom || !!title.trim()) && (!self || hasCwd);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    const created = await act(() =>
      api<Employee>('POST', '/employees', {
        name: name.trim(),
        roleKey: custom ? null : roleKey,
        ...(custom ? { title: title.trim(), department: department.trim() || undefined, specialization: specialization.trim(), skills: parseSkills(skills) } : {}),
        hostId,
        ...(deskId && roleKey !== 'foreman' ? { deskId } : {}),
        projectId: projectId || null,
        // A folder with no shared project becomes this employee's own in-place project (server side).
        workingDir: projectId ? null : workingDir.trim() || null,
        autonomy: effectiveAutonomy,
        style,
        model: model.trim() || null,
        effort: effort || null,
        executionMode,
        instructions,
        ...(self ? { selfDriven: true } : {}),
      }),
    );
    if (!created) {
      setBusy(false);
      return;
    }
    if (!self) useOffice.getState().toast(`${created.name} joined as ${created.title}`, 'success');
    // The employee exists either way; a failed start is reported and can be retried from their profile.
    if (startNow || self) await act(() => api('POST', `/employees/${created.id}/start`, {}), self ? 'Your session is starting' : `${created.name}'s session is starting`);
    setBusy(false);
    onDone(created.id);
  };

  return (
    <form
      className="col"
      style={{ gap: 14 }}
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
    >
      <div className="grid2">
        <Field label={self ? 'Name on the desk' : 'Name'}>
          <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="e.g. Alex" autoFocus={!self} />
        </Field>
        {!self && (
          <Field label="Role">
            <select value={roleKey} onChange={(ev) => setRoleKey(ev.target.value)}>
              {ROLE_CATALOGUE.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.title}
                </option>
              ))}
              <option value="custom">Custom role…</option>
            </select>
          </Field>
        )}
      </div>
      <div className="grid2">
        <ModelEffortFields model={model} effort={effort} onModel={setModel} onEffort={setEffort} host={host} />
      </div>
      {custom && (
        <div className="grid2">
          <Field label="Title">
            <input value={title} onChange={(ev) => setTitle(ev.target.value)} placeholder="e.g. Data Engineer" />
          </Field>
          <Field label="Department">
            <input value={department} onChange={(ev) => setDepartment(ev.target.value)} placeholder="Engineering" />
          </Field>
          <Field label="Specialisation">
            <input value={specialization} onChange={(ev) => setSpecialization(ev.target.value)} placeholder="What they focus on" />
          </Field>
          <Field label="Skills" hint="Comma separated">
            <input value={skills} onChange={(ev) => setSkills(ev.target.value)} placeholder="Python, SQL, Airflow" />
          </Field>
        </div>
      )}
      <div className="section-title" style={{ margin: 0 }}>
        {self ? 'The folder to open' : '2 · Their folder'} {place.mine && !place.host.ownerId ? 'on your computer' : `on ${place.host.name}`}
      </div>
      <Field label={self ? 'Claude Code starts in this folder' : 'Folder they live in'} hint={projectId ? `They join the shared project "${project?.name}", so they get their own worktree instead of a folder.` : undefined} wide>
        <FolderField value={workingDir} onChange={setWorkingDir} host={host} disabled={!!projectId} />
      </Field>

      {roleKey === 'foreman' ? (
        <div className="card small" data-foreman-note>
          <span className="strong">A foreman has no desk.</span> It walks the office — the shared floor and every member's room that is open — goes to whoever needs something, and keeps the work going: it answers operational questions, hands out
          ready work and gets people who stopped moving again. There is one for the whole office and it runs on the office's own machine. Hiring it switches its rounds on (Settings → Foreman pauses them); each round uses that machine's Claude account.
          {place.mine && <div className="bad" style={{ marginTop: 6 }}>Choose the shared office in step 1: the foreman cannot run on your own computer.</div>}
          {existingForeman && <div className="bad" style={{ marginTop: 6 }}>The office already has a foreman ({existingForeman.name}).</div>}
        </div>
      ) : self ? null : (
        <>
          <div className="section-title" style={{ margin: 0 }}>
            3 · Their desk {place.mine ? 'in your room' : 'in the office'}
          </div>
          <DeskPicker place={place} value={deskId} onChange={setDeskId} />
        </>
      )}

      <div className="small muted">
        {self ? (
          <>
            {!hasCwd ? 'Choose the folder first.' : canStart ? 'The session starts now and its terminal opens with the keyboard in your hands.' : `${host?.name ?? 'That machine'} is offline: the session starts when it is back.`} It uses {place.mine ? 'your own' : "the server's"} Claude account.
            The office gives it no work; you can still hand it a task yourself.{' '}
          </>
        ) : (
          <>
            {!hasCwd ? 'Without a folder they cannot be started yet.' : startNow && canStart ? 'Their session starts right away.' : 'Their session starts when you first talk to them or give them a task.'} {autonomyInfo(effectiveAutonomy).label}: {autonomyInfo(effectiveAutonomy).text}{' '}
          </>
        )}
        <button type="button" className="fp-link" style={{ display: 'inline' }} onClick={() => setMore((m) => !m)}>
          {more ? 'Fewer options' : 'More options'}
        </button>
      </div>

      {more && (
        <div className="col hire-more" style={{ gap: 14 }}>
          <div className="grid2">
            <Field label="…or an existing project there" hint={project && !project.repoPath ? 'This project has no repository path; give them a folder instead.' : 'Instead of their own folder: an isolated worktree, merged when work is verified.'}>
              <select value={projectId} onChange={(ev) => setProjectId(ev.target.value)}>
                <option value="">None — they own the folder above</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div>
            <div className="section-title">How much they may do without asking</div>
            <AutonomyPicker name="hire-autonomy" value={effectiveAutonomy} onChange={setAutonomy} />
          </div>
          <div className="grid2">
            <Field label="Communication style">
              <select value={style} onChange={(ev) => setStyle(ev.target.value as CommunicationStyle)}>
                {STYLES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <RuntimeField value={executionMode} onChange={setExecutionMode} host={host} />
            <Field label="Standing instructions" hint="Added to the system prompt of every session they start." wide>
              <textarea value={instructions} onChange={(ev) => setInstructions(ev.target.value)} placeholder="Anything this employee should always keep in mind." />
            </Field>
          </div>
          {role && (
            <div className="small faint">
              <span className="muted">{role.title}:</span> {role.instructions}
            </div>
          )}
          {!self && (
            <label className="check">
              <input type="checkbox" checked={startNow} onChange={(ev) => setStartNow(ev.target.checked)} />
              <span>Start their session right away (otherwise it starts when you first talk to them)</span>
            </label>
          )}
        </div>
      )}

      <div className="row">
        <Button variant="primary" type="submit" disabled={!valid || busy}>
          {self ? (busy ? 'Starting…' : 'Sit down and start') : busy ? 'Hiring…' : 'Hire'}
        </Button>
        <Button variant="ghost" type="button" onClick={() => onDone()} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ───────────────────────────── Team ─────────────────────────────

function TeamPanel({ arg, onClose }: PanelProps) {
  const employeesById = useOffice((s) => s.employees);
  const sessions = useOffice((s) => s.sessions);
  const hosts = useOffice((s) => s.hosts);
  const projects = useOffice((s) => s.projects);
  const tasks = useOffice((s) => s.tasks);
  const questions = useOffice((s) => s.questions);
  const gamification = useOffice((s) => s.settings?.gamification !== false);
  const [search, setSearch] = useState('');
  const [projectId, setProjectId] = useState('');
  const [hostId, setHostId] = useState('');
  // `openPanel('team', 'hire')` goes straight to the hiring form.
  // `hire@<desk>` and `me@<desk>` come from an empty desk: hire for that desk, or sit there oneself.
  const atDesk = arg && /^(hire|me)@/.test(arg) ? arg.slice(arg.indexOf('@') + 1) : undefined;
  const self = !!arg?.startsWith('me@');
  const [hiring, setHiring] = useState<false | 'one' | 'many'>(arg === 'hire' || atDesk ? 'one' : arg === 'hire-many' ? 'many' : false);
  // Step one of hiring: the shared office or my own room. Chosen by the person, unless there is only one place.
  const { places: allPlaces } = useHirePlaces();
  // A desk decides the place: a seat in my room is on my computer, a desk in the office is on a shared machine.
  const seatHost = memberSeatOf(atDesk)?.hostId;
  const only = atDesk ? (seatHost ? 'mine' : 'shared') : undefined;
  // (A seat in my room goes with the computer it is named after, or with any server of mine: who works there sits in my room too.)
  const places = only ? allPlaces.filter((p) => (only === 'mine' ? p.mine && (p.host.id === seatHost || !!p.host.ownerId) : !p.mine)) : allPlaces;
  const [where, setWhere] = useState('');
  const place = places.find((p) => p.host.id === where) ?? (places.length === 1 ? places[0] : undefined);
  // Sitting down oneself: once the session exists, open its terminal and take the keyboard.
  const sitDown = (id?: string) => {
    if (!id) return onClose();
    const st0 = useOffice.getState();
    st0.openPanel(null);
    st0.enterWorkstation(id);
    let tries = 0;
    const take = window.setInterval(() => {
      const now = useOffice.getState();
      const session = sessionOfEmployee(now.sessions, id);
      if (now.workstationId !== id || ++tries > 60) return window.clearInterval(take);
      if (session?.status === 'running') {
        window.clearInterval(take);
        connection.send({ t: 'control.acquire', sessionId: session.id });
      }
    }, 500);
  };

  const all = useMemo(() => Object.values(employeesById).sort(byName), [employeesById]);
  // The foreman is not one of the seated employees: it is shown on its own, above the list.
  const foreman = all.find((e) => !e.archived && e.roleKey === 'foreman');
  const foremanOn = useOffice((s) => !!s.settings?.foreman?.enabled);
  const active = all.filter((e) => !e.archived && e.id !== foreman?.id);
  const archived = all.filter((e) => e.archived);
  const needle = search.trim().toLowerCase();
  // One's own employees alone, or everyone with one's own first.
  const { scope, own } = useScope();
  const me = useOffice((s) => s.me);
  const visitor = me?.role === 'visitor';
  const isMine = (e: Employee) => whoseEmployee(hosts, me, e).kind === 'mine';
  const shown = scoped(active, scope, own, isMine).filter(
    (e) => (!projectId || e.projectId === projectId) && (!hostId || e.hostId === hostId) && (!needle || `${e.name} ${e.title} ${e.department} ${e.specialization} ${e.skills.join(' ')}`.toLowerCase().includes(needle)),
  );
  const st = useOffice.getState();

  if (hiring) {
    return (
      <Window
        kit
        title={self ? 'Sit here with your own Claude Code' : hiring === 'many' ? 'Hire one employee per project folder' : atDesk ? 'Hire someone for this desk' : 'Hire an employee'}
        subtitle={self ? 'A session of your own at this desk: you type, the office only shows it' : 'An employee is a Claude Code session with a name, a folder and a desk'}
        onClose={onClose}
        width={hiring === 'many' ? 1080 : 860}
      >
        {!atDesk && (
          <div className="seg" role="tablist" aria-label="How many to hire" style={{ marginBottom: 14 }}>
            <button role="tab" aria-selected={hiring === 'one'} className={hiring === 'one' ? 'seg-on' : ''} onClick={() => setHiring('one')}>
              One employee
            </button>
            <button role="tab" aria-selected={hiring === 'many'} className={hiring === 'many' ? 'seg-on' : ''} onClick={() => setHiring('many')}>
              One per project folder
            </button>
          </div>
        )}
        {/* With one possible place there is nothing to choose: say where it is and go on. */}
        {places.length > 1 || !place ? (
          <>
            <div className="section-title" style={{ marginTop: 0 }}>
              {self ? 'On which machine?' : '1 · Where do they work?'}
            </div>
            <WherePicker value={place?.host.id ?? where} onChange={setWhere} only={only} />
            <div style={{ height: 14 }} />
          </>
        ) : (
          <div className="small muted" style={{ marginBottom: 12 }}>
            {place.mine ? (place.host.ownerId ? `On your server ${place.host.name}, in your room.` : `On your computer (${place.host.name}), in your room.`) : `In the shared office, on ${place.host.name}.`}
          </div>
        )}
        {!place ? (
          places.length > 0 && <div className="card small muted">{self ? 'Choose the machine first.' : 'Choose where they work first: in the shared office on the server, or in your own room on your computer. The folder and the desk follow from that.'}</div>
        ) : place.problem && !place.mine ? (
          <div className="card small bad">{place.problem}. {self ? 'The session starts when it is back.' : 'They can be hired now and started when it is back.'}</div>
        ) : null}
        {place &&
          (hiring === 'many' ? (
            <BulkHire key={place.host.id} onlyHostId={place.host.id} onDone={() => setHiring(false)} />
          ) : (
            <HireForm key={place.host.id} place={place} desk={atDesk} self={self} onDone={(id) => (self ? sitDown(id) : atDesk ? onClose() : setHiring(false))} />
          ))}
      </Window>
    );
  }

  const working = active.filter((e) => isWorking(activityOf(sessionOfEmployee(sessions, e.id)))).length;
  // Under their projects; within one, whoever wants somebody first.
  const groups = byProject(byAttention(shown.map((e) => ({ name: e.name, projectId: e.projectId, e, state: employeeState(activityOf(sessionOfEmployee(sessions, e.id)), openQuestionsOf(questions, e.id).length > 0) }))), projects);

  /** One of the team: a face, a name, how they are and on what. A click opens their profile; Talk is beside it. */
  const card = (e: Employee, state: ReturnType<typeof employeeState>) => {
    const session = sessionOfEmployee(sessions, e.id);
    const task = currentTaskOf(tasks, e.id);
    const whose = whoseEmployee(hosts, me, e);
    const open = () => st.openPanel('employee', e.id);
    return (
      <div key={e.id} className="tm-card" role="button" tabIndex={0} onClick={open} onKeyDown={(ev) => ev.target === ev.currentTarget && onActivate(open)(ev)} data-team-employee={e.id} title={`${e.name} — ${e.title}. Open their profile`}>
        <Avatar appearance={e.appearance} size={36} offline={!isLive(session)} />
        <div className="k-main">
          <div className="k-title">
            {e.name}
            {/* Whose they are is said where it is not the office's own: a member's, or one I look after. */}
            {(whose.kind === 'member' || (whose.kind === 'mine' && own)) && <span className="k-title-note">{whoseLabel(whose)}</span>}
          </div>
          <div className="k-line">
            <State {...state} />
            <span className="k-sub">{task ? `${task.key} ${task.title}` : e.title}</span>
          </div>
        </div>
        {!visitor && (
          <Button
            small
            variant="ghost"
            className="k-quiet"
            onClick={(ev) => {
              ev.stopPropagation();
              st.openPanel('talk', e.id);
            }}
          >
            Talk
          </Button>
        )}
      </div>
    );
  };

  return (
    <Window
      kit
      title="Team"
      subtitle={teamLine({ employees: active.length, working, archived: archived.length })}
      onClose={onClose}
      width={1120}
      actions={
        visitor ? undefined : (
          <Button variant="primary" onClick={() => setHiring('one')} title="One employee, or one for each of several project folders">
            Hire
          </Button>
        )
      }
    >
      <div className="k-stack" data-team>
        <div className="k-tools">
          <input className="k-find" value={search} onChange={(ev) => setSearch(ev.target.value)} placeholder="Find somebody by name, title or skill…" aria-label="Search employees" autoFocus />
          <select value={projectId} onChange={(ev) => setProjectId(ev.target.value)} aria-label="Filter by project">
            <option value="">All projects</option>
            {Object.values(projects)
              .sort(byName)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <select value={hostId} onChange={(ev) => setHostId(ev.target.value)} aria-label="Filter by machine">
            <option value="">All machines</option>
            {Object.values(hosts)
              .filter((h) => h.status !== 'revoked' || active.some((e) => e.hostId === h.id))
              .sort(byName)
              .map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
          </select>
          <ScopeSwitch what="employees" />
        </div>

        {foreman && scope === 'all' && (
          <div className="k-group team-foreman" data-foreman={foreman.id}>
            <div className="k-row">
              <Avatar appearance={foreman.appearance} size={36} offline={!isLive(sessionOfEmployee(sessions, foreman.id))} />
              <div className="k-main">
                <div className="k-title">
                  {foreman.name}
                  <span className="k-title-note">the foreman — no desk: walks the whole office and keeps the work going</span>
                </div>
                <div className="k-line">
                  <State {...employeeState(activityOf(sessionOfEmployee(sessions, foreman.id)), openQuestionsOf(questions, foreman.id).length > 0)} />
                  <span className="k-sub">
                    {foremanOn ? 'rounds are on' : 'rounds are paused'} · on {foreman.hostId ? (hosts[foreman.hostId]?.name ?? 'no machine') : 'no machine'}
                  </span>
                </div>
              </div>
              <Button small variant="ghost" className="k-quiet" onClick={() => st.openPanel('settings', 'foreman')} title="When it goes round, and to whom">
                Rounds
              </Button>
              <Button small variant="ghost" className="k-quiet" onClick={() => st.openPanel('employee', foreman.id)}>
                Profile
              </Button>
            </div>
          </div>
        )}

        {active.length === 0 ? (
          <div className="k-empty">
            <div className="k-title">Nobody works here yet</div>
            <div className="k-text">An employee is a Claude Code session with a name, a folder and a desk. Hire the first one, and give them a project.</div>
            {!visitor && (
              <Button variant="primary" onClick={() => setHiring('one')}>
                Hire
              </Button>
            )}
          </div>
        ) : shown.length === 0 ? (
          <div className="k-empty">
            <div className="k-title">{own && scope === 'mine' && !needle && !projectId && !hostId ? 'Nobody works for you alone yet' : 'Nobody matches'}</div>
            <div className="k-text">{own && scope === 'mine' ? 'Your own employees are the ones on your computer and servers. The rest of the office is under Everyone.' : 'Change what you typed or the filters.'}</div>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.project?.id ?? 'none'} className="k-section" data-team-group={g.project?.id ?? ''}>
              <div className="k-head">
                <button type="button" className="tm-project" disabled={!g.project} onClick={() => g.project && st.openPanel('projects', g.project.id)} title={g.project ? 'Open the project' : undefined}>
                  <span className="k-dot" style={{ background: g.project?.color ?? 'var(--faint)', boxShadow: 'none' }} aria-hidden />
                  {g.project?.name ?? 'No project'}
                  <span className="tm-count">{g.people.length}</span>
                </button>
              </div>
              <div className="tm-grid">{g.people.map((x) => card(x.e, x.state))}</div>
            </section>
          ))
        )}

        {archived.length > 0 && (
          <More summary={`${archived.length} archived`}>
            <div className="k-group" data-team-archived>
              {archived.map((e) => (
                <div key={e.id} className="k-row k-row-sm" style={{ flexWrap: 'wrap' }}>
                  <Avatar appearance={e.appearance} size={24} offline />
                  <div className="k-main">
                    <div className="k-title k-title-sm">
                      {e.name}
                      <span className="k-title-note">{e.title}</span>
                    </div>
                  </div>
                  <Button small variant="ghost" className="k-quiet" onClick={() => st.openPanel('employee', e.id)}>
                    Profile
                  </Button>
                  <Button small onClick={() => act(() => api('PATCH', `/employees/${e.id}`, { archived: false }), `${e.name} is back on the team`)}>
                    Restore
                  </Button>
                  <DeleteEmployee e={e} inline />
                </div>
              ))}
            </div>
          </More>
        )}
      </div>
    </Window>
  );
}
registerPanel('team', TeamPanel);

// ─────────────────────────── Employee ───────────────────────────

type TabId = 'overview' | 'profile' | 'appearance' | 'session' | 'message' | 'history' | 'desk';
const TAB_ARG: Record<string, TabId> = { overview: 'overview', settings: 'profile', profile: 'profile', appearance: 'appearance', session: 'session', message: 'message', history: 'history', desk: 'desk' };

interface Draft {
  name: string;
  title: string;
  department: string;
  roleKey: string;
  specialization: string;
  skills: string;
  style: CommunicationStyle;
  model: string;
  effort: string;
  instructions: string;
  allowedTools: string;
  disallowedTools: string;
  autonomy: AutonomyLevel;
  executionMode: ExecutionMode;
  projectId: string;
  alsoProjectIds: string[];
  hostId: string;
  workingDir: string;
  claudeConfigDir: string;
}

function draftOf(e: Employee): Draft {
  return {
    name: e.name,
    title: e.title,
    department: e.department,
    roleKey: e.roleKey,
    specialization: e.specialization,
    skills: e.skills.join(', '),
    style: e.style,
    model: e.model ?? '',
    effort: e.effort ?? '',
    instructions: e.instructions,
    allowedTools: e.allowedTools.join('\n'),
    disallowedTools: e.disallowedTools.join('\n'),
    autonomy: e.autonomy,
    executionMode: e.executionMode,
    projectId: e.projectId ?? '',
    alsoProjectIds: e.alsoProjectIds ?? [],
    hostId: e.hostId ?? '',
    workingDir: e.workingDir ?? '',
    claudeConfigDir: e.claudeConfigDir ?? '',
  };
}

/** Permission rules, one per line (a rule may contain commas, e.g. `Bash(git log:*)`). */
function parseRules(text: string): string[] {
  return [...new Set(text.split('\n').map((x) => x.trim()).filter(Boolean))].slice(0, 100);
}

/** Only what actually changed is sent. A role change always carries the title fields so the result is what the form shows. */
function patchOf(e: Employee, d: Draft): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const role = d.roleKey !== e.roleKey;
  const skills = parseSkills(d.skills);
  if (d.name.trim() !== e.name) p.name = d.name.trim();
  if (role) p.roleKey = d.roleKey;
  if (role || d.title.trim() !== e.title) p.title = d.title.trim();
  if (role || d.department.trim() !== e.department) p.department = d.department.trim();
  if (role || d.specialization.trim() !== e.specialization) p.specialization = d.specialization.trim();
  if (role || skills.join('\n') !== e.skills.join('\n')) p.skills = skills;
  if (d.style !== e.style) p.style = d.style;
  if ((d.model.trim() || null) !== e.model) p.model = d.model.trim() || null;
  if ((d.effort || null) !== (e.effort ?? null)) p.effort = d.effort || null;
  if (d.instructions !== e.instructions) p.instructions = d.instructions;
  if (parseRules(d.allowedTools).join('\n') !== e.allowedTools.join('\n')) p.allowedTools = parseRules(d.allowedTools);
  if (parseRules(d.disallowedTools).join('\n') !== e.disallowedTools.join('\n')) p.disallowedTools = parseRules(d.disallowedTools);
  if (d.autonomy !== e.autonomy) p.autonomy = d.autonomy;
  if (d.executionMode !== e.executionMode) p.executionMode = d.executionMode;
  if ((d.projectId || null) !== e.projectId) p.projectId = d.projectId || null;
  if ([...d.alsoProjectIds].sort().join() !== [...(e.alsoProjectIds ?? [])].sort().join()) p.alsoProjectIds = d.alsoProjectIds.filter((x) => x !== d.projectId);
  if ((d.hostId || null) !== e.hostId) p.hostId = d.hostId || null;
  if ((d.workingDir.trim() || null) !== e.workingDir) p.workingDir = d.workingDir.trim() || null;
  if ((d.claudeConfigDir.trim() || null) !== (e.claudeConfigDir ?? null)) p.claudeConfigDir = d.claudeConfigDir.trim() || null;
  return p;
}

const XP_REASON: Record<string, string> = {
  task_completed: 'Task verified done',
  tests_passed: 'Verification passed',
  bug_fixed: 'Bug fixed',
  review_completed: 'Review completed',
  deliverable_accepted: 'Deliverable accepted',
  assist: 'Assist',
};

function XpLedger({ e }: { e: Employee }) {
  const tasks = useOffice((s) => s.tasks);
  // The ledger changes only when XP does; the query string is just a refetch key.
  const load = useLoad<XpEntry[]>(`/employees/${e.id}/xp?at=${e.xp}`);
  const rows = load.data ?? [];
  return (
    <div>
      <div className="section-title">XP ledger — every entry cites its evidence</div>
      <LoadState load={load} what="the XP ledger" />
      {load.data && rows.length === 0 && <div className="small muted">No XP yet. XP is awarded only for verified work: a passed verification, an approved review, an accepted deliverable.</div>}
      {rows.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>XP</th>
              <th>Reason</th>
              <th>Note</th>
              <th>Evidence</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => {
              const task = tasks[x.evidenceRef];
              return (
                <tr key={x.id}>
                  <td className="strong pc-nowrap">+{fmtInt(x.amount)}</td>
                  <td className="pc-nowrap">{XP_REASON[x.reason] ?? humanize(x.reason)}</td>
                  <td>{x.note}</td>
                  <td>
                    {task ? (
                      <button className="btn btn-ghost btn-sm mono" title={task.title} onClick={() => useOffice.getState().openPanel('task', task.id)}>
                        {task.key}
                      </button>
                    ) : (
                      <span className="mono faint" title={x.evidenceRef}>
                        {x.evidenceRef.length > 14 ? `${x.evidenceRef.slice(0, 13)}…` : x.evidenceRef}
                      </span>
                    )}
                  </td>
                  <td className="small muted pc-nowrap" title={fmtDateTime(x.ts)}>
                    {timeAgo(x.ts)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Delete an employee for good, with what is theirs. Archiving keeps everything and can be undone; this cannot.
 * Shown to those who may: an owner, or a colleague for their own employee on their own computer.
 */
function DeleteEmployee({ e, onDone, inline }: { e: Employee; onDone?: () => void; inline?: boolean }) {
  const can = useAccess();
  const tasks = useOffice((s) => s.tasks);
  const sessions = useOffice((s) => s.sessions);
  const [asking, setAsking] = useState(false);
  const [withTasks, setWithTasks] = useState(true);
  const [busy, setBusy] = useState(false);
  if (!can.deleteEmployee(e.hostId)) return null;
  const theirs = Object.values(tasks).filter((t) => t.assigneeId === e.id);
  const open = theirs.filter((t) => t.status !== 'DONE').length;
  const live = isLive(sessionOfEmployee(sessions, e.id));
  const remove = async () => {
    setBusy(true);
    const res = await act(() => api<{ name: string }>('DELETE', `/employees/${e.id}${withTasks ? '?tasks=delete' : ''}`), `${e.name} was deleted`);
    setBusy(false);
    setAsking(false);
    if (res) onDone?.();
  };
  if (!asking)
    return (
      <Button variant="ghost" className="k-quiet" small onClick={() => setAsking(true)} title="Remove this employee and what is theirs from the office for good. Nothing on disk is touched">
        {inline ? 'Delete…' : 'Delete employee…'}
      </Button>
    );
  return (
    <div style={inline ? { flexBasis: '100%' } : { marginTop: 6 }}>
      <ConfirmBox title={`Delete ${e.name} for good?`} confirmLabel={withTasks && theirs.length ? `Delete ${e.name} and ${theirs.length} task${theirs.length === 1 ? '' : 's'}` : `Delete ${e.name}`} busy={busy} onConfirm={remove} onCancel={() => setAsking(false)}>
        This cannot be undone. Gone with them: their sessions and the record of them, the messages to and from them, their questions, routines, own lessons and XP.
        {live && ` ${e.name}'s running session is stopped first.`} The folders, branches and conversations on the machine are left as they are, and so is the record of what happened (the feed and the audit log).
        {theirs.length > 0 && (
          <label className="row" style={{ gap: 6, marginTop: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={withTasks} onChange={(ev) => setWithTasks(ev.target.checked)} />
            <span>
              Also delete the {theirs.length} task{theirs.length === 1 ? '' : 's'} assigned to them{open ? ` (${open} not finished)` : ''}. Unticked: {open ? 'the unfinished ones go back on the board for someone else, and ' : ''}finished ones stay as a record.
            </span>
          </label>
        )}
      </ConfirmBox>
    </div>
  );
}

function ProfileTab({ e, onClose }: { e: Employee; onClose: () => void }) {
  const hostsById = useOffice((s) => s.hosts);
  const projectsById = useOffice((s) => s.projects);
  const sessions = useOffice((s) => s.sessions);
  const [d, setD] = useState<Draft>(() => draftOf(e));
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((cur) => ({ ...cur, [key]: value }));
  const patch = patchOf(e, d);
  const dirty = Object.keys(patch).length > 0;
  const valid = !!d.name.trim() && !!d.title.trim();
  const session = sessionOfEmployee(sessions, e.id);
  const live = isLive(session);
  const role = roleByKey(d.roleKey);
  const hosts = Object.values(hostsById)
    .filter((h) => h.status !== 'revoked' || h.id === e.hostId)
    .sort(byName);
  const projects = Object.values(projectsById)
    .filter((p) => p.status !== 'archived' || p.id === e.projectId)
    .sort(byName);

  const pickRole = (key: string) => {
    const r = roleByKey(key);
    setD((cur) => (r ? { ...cur, roleKey: key, title: r.title, department: r.department, specialization: r.specialization, skills: r.skills.join(', ') } : { ...cur, roleKey: 'custom' }));
  };
  const save = async () => {
    setBusy(true);
    const res = await act(() => api<Employee>('PATCH', `/employees/${e.id}`, patch), 'Profile saved');
    setBusy(false);
    if (res) setD(draftOf(res));
  };
  const archive = async () => {
    setBusy(true);
    // The server refuses while a session is running; its message is shown as it is.
    const res = await act(() => api<Employee>('PATCH', `/employees/${e.id}`, { archived: true }), `${e.name} was archived`);
    setBusy(false);
    setArchiving(false);
    if (res) onClose();
  };
  // Open from the start when something in it is set, and then as the person leaves it.
  const [more, setMore] = useState(() => !!(e.claudeConfigDir || e.instructions || e.allowedTools.length || e.disallowedTools.length || e.executionMode !== 'interactive_cli'));
  // What the office starts their session again for by itself, and what waits for the next start.
  const restartsNow = live && ('autonomy' in patch || 'model' in patch || 'effort' in patch || 'claudeConfigDir' in patch);
  const restartSensitive = live && ('instructions' in patch || 'allowedTools' in patch || 'disallowedTools' in patch || 'roleKey' in patch || 'executionMode' in patch);

  return (
    <div className="k-stack pf-form" data-profile-settings>
      <div>
        <div className="k-label">Who they are</div>
        <div className="grid2">
        <Field label="Name">
          <input value={d.name} onChange={(ev) => set('name', ev.target.value)} />
        </Field>
        <Field label="Role">
          <select value={role ? d.roleKey : 'custom'} onChange={(ev) => pickRole(ev.target.value)}>
            {ROLE_CATALOGUE.map((r) => (
              <option key={r.key} value={r.key}>
                {r.title}
              </option>
            ))}
            <option value="custom">Custom role</option>
          </select>
        </Field>
        <Field label="Title">
          <input value={d.title} onChange={(ev) => set('title', ev.target.value)} />
        </Field>
        <Field label="Skills" hint="Comma separated">
          <input value={d.skills} onChange={(ev) => set('skills', ev.target.value)} />
        </Field>
        </div>
      </div>
      <div>
        <div className="k-label">Where they work</div>
        <div className="grid3">
        <Field label="Machine" hint={live ? 'Stop the running session before moving them to another machine.' : undefined}>
          <select value={d.hostId} onChange={(ev) => set('hostId', ev.target.value)}>
            <option value="">No machine</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} ({h.status})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project">
          <select value={d.projectId} onChange={(ev) => set('projectId', ev.target.value)}>
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Working directory" hint="Used when there is no project repository.">
          <input value={d.workingDir} onChange={(ev) => set('workingDir', ev.target.value)} className="mono" placeholder="none" />
        </Field>
        {projects.filter((p) => p.id !== d.projectId).length > 0 && (
          <Field label="Also works on" hint="Other projects this employee may be given tasks from. Their own project stays the one above.">
            <div className="row row-wrap" style={{ gap: 10 }}>
              {projects
                .filter((p) => p.id !== d.projectId)
                .map((p) => (
                  <label key={p.id} className="check small" style={{ alignItems: 'center' }}>
                    <input type="checkbox" checked={d.alsoProjectIds.includes(p.id)} onChange={(ev) => set('alsoProjectIds', ev.target.checked ? [...d.alsoProjectIds, p.id] : d.alsoProjectIds.filter((x) => x !== p.id))} style={{ marginTop: 0 }} />
                    {p.name}
                  </label>
                ))}
            </div>
          </Field>
        )}
        </div>
      </div>
      <div>
        <div className="k-label">What they think with</div>
        <div className="grid2">
          <ModelEffortFields model={d.model} effort={d.effort} onModel={(v) => set('model', v)} onEffort={(v) => set('effort', v)} host={d.hostId ? hostsById[d.hostId] : undefined} />
        </div>
      </div>
      <div>
        <div className="k-label">How much they may do without asking</div>
        <AutonomyPicker name={`autonomy-${e.id}`} value={d.autonomy} onChange={(v) => set('autonomy', v)} />
      </div>
      {/* What is rarely changed stays folded away, unless something in it is set. */}
      <details className="pc-more k-more" open={more} onToggle={(ev) => setMore((ev.currentTarget as HTMLDetailsElement).open)}>
        <summary>More settings: account, instructions, tools</summary>
        <div className="col" style={{ gap: 14, marginTop: 10 }}>
          <div className="grid3">
        <Field label="Department">
          <input value={d.department} onChange={(ev) => set('department', ev.target.value)} />
        </Field>
        <Field label="Specialisation">
          <input value={d.specialization} onChange={(ev) => set('specialization', ev.target.value)} />
        </Field>
        <Field label="Communication style">
          <select value={d.style} onChange={(ev) => set('style', ev.target.value as CommunicationStyle)}>
            {STYLES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <RuntimeField value={d.executionMode} onChange={(v) => set('executionMode', v)} host={d.hostId ? hostsById[d.hostId] : undefined} />
        <Field label="Claude account folder" hint="Leave empty to use the machine's own Claude login. More accounts are added to a machine in Company → Claude; pick one here, or write the folder of a login made by hand. A running session is started again on the new account. When an account runs out, the office moves its employees to another one by itself (Settings → Employees).">
          <input value={d.claudeConfigDir} onChange={(ev) => set('claudeConfigDir', ev.target.value)} className="mono" placeholder="default login" spellCheck={false} aria-label="Claude account folder" list="claude-accounts-of-machine" />
          <datalist id="claude-accounts-of-machine">
            {(hostsById[d.hostId ?? '']?.claudeAccounts ?? []).map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </Field>
          </div>
      {role && (
        <div className="small faint">
          <span className="muted">Role brief (appended to the system prompt):</span> {role.instructions}
        </div>
      )}
      <Field label="Standing instructions" hint="Appended to the system prompt of every session they start.">
        <textarea value={d.instructions} onChange={(ev) => set('instructions', ev.target.value)} placeholder="Anything this employee should always keep in mind." />
      </Field>
          <div className="grid2">
        <Field label="Always allowed tools" hint="Claude Code permission rules, one per line — e.g. Bash(npm run lint:*) or WebFetch. Added to what the project and autonomy level already allow.">
          <textarea className="mono" value={d.allowedTools} onChange={(ev) => set('allowedTools', ev.target.value)} placeholder="Bash(npm run lint:*)" spellCheck={false} style={{ minHeight: 64 }} />
        </Field>
        <Field label="Never allowed tools" hint="Rules this employee may never use, one per line — e.g. WebSearch or Bash(docker:*). A denied rule wins over an allowed one.">
          <textarea className="mono" value={d.disallowedTools} onChange={(ev) => set('disallowedTools', ev.target.value)} placeholder="Bash(docker:*)" spellCheck={false} style={{ minHeight: 64 }} />
        </Field>
          </div>
        </div>
      </details>
      <div>
        <div className="k-label">Employment</div>
        {e.archived ? (
          <Button variant="success" small onClick={() => act(() => api('PATCH', `/employees/${e.id}`, { archived: false }), `${e.name} is back on the team`)}>
            Restore to the team
          </Button>
        ) : archiving ? (
          <ConfirmBox title={`Archive ${e.name}?`} confirmLabel="Archive employee" busy={busy} onConfirm={archive} onCancel={() => setArchiving(false)}>
            They leave their desk and stop receiving work. Their history, XP and records are kept, and they can be restored later.
            {live && (
              <>
                <br />
                {e.name} has a running session; the server refuses to archive until it is stopped.
              </>
            )}
          </ConfirmBox>
        ) : (
          <div className="k-text">Archiving takes them off the team and keeps everything of theirs; it can be undone. Deleting cannot.</div>
        )}
        <div className="k-actions">
          {!e.archived && !archiving && (
            <Button small onClick={() => setArchiving(true)}>
              Archive employee…
            </Button>
          )}
          {!archiving && <DeleteEmployee e={e} onDone={onClose} />}
        </div>
      </div>
      <div className="pf-save" data-profile-save>
        <div className={`pf-save-note ${restartSensitive || restartsNow ? 'k-warn' : ''}`}>
          {!dirty
            ? live
              ? 'Nothing is changed. A change of autonomy, model or account starts their session again by itself; role, instructions and tools reach a session at its next start.'
              : 'Nothing is changed. Changes take effect the next time their session is started.'
            : !live
              ? `Unsaved: ${Object.keys(patch).join(', ')}. Takes effect the next time their session is started.`
              : restartsNow
                ? `Unsaved: ${Object.keys(patch).join(', ')}. Saving starts ${e.name}'s session again with the same conversation — now if they are between turns, otherwise when their turn ends.${restartSensitive ? ' Role, instructions and tools come with that start too.' : ''}`
                : restartSensitive
                  ? `Unsaved: ${Object.keys(patch).join(', ')}. Role, instructions and tools reach a session when it starts: stop and start theirs to apply those.`
                  : `Unsaved: ${Object.keys(patch).join(', ')}.`}
        </div>
        <Button variant="ghost" className="k-quiet" disabled={!dirty || busy} onClick={() => setD(draftOf(e))}>
          Discard
        </Button>
        <Button variant="primary" disabled={!dirty || !valid || busy} onClick={save}>
          Save changes
        </Button>
      </div>

    </div>
  );
}

const HAIR_STYLES: Appearance['hairStyle'][] = ['short', 'long', 'bun', 'curly', 'bald'];
const ACCESSORIES: Appearance['accessory'][] = ['none', 'glasses', 'headphones', 'cap'];

/**
 * Looks that are earned with levels: the level from which this editor offers them.
 * This is a rule of the editor only — the server stores whatever appearance it is sent and is
 * deliberately left unchanged — and it gates looks, never capabilities. A look an employee
 * already wears stays selectable whatever their level, so nothing is ever taken away.
 */
const LOOK_UNLOCKS: { accessory: Partial<Record<Appearance['accessory'], number>>; hairStyle: Partial<Record<Appearance['hairStyle'], number>> } = {
  accessory: { cap: 3, headphones: 5 },
  hairStyle: { curly: 8 },
};

function AppearanceTab({ e }: { e: Employee }) {
  const [a, setA] = useState<Appearance>(e.appearance);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Appearance>(key: K, value: Appearance[K]) => setA((cur) => ({ ...cur, [key]: value }));
  const dirty = (Object.keys(a) as Array<keyof Appearance>).some((k) => a[k] !== e.appearance[k]);
  /** The level an option still needs, or null when this employee may wear it (earned, or already theirs). */
  const lockedAt = <K extends 'accessory' | 'hairStyle'>(key: K, value: Appearance[K]): number | null => {
    const need = (LOOK_UNLOCKS[key] as Partial<Record<string, number>>)[value] ?? 1;
    return e.level >= need || e.appearance[key] === value ? null : need;
  };
  const unlocks = [...Object.entries(LOOK_UNLOCKS.accessory).map(([v, n]) => ({ label: v, level: n! })), ...Object.entries(LOOK_UNLOCKS.hairStyle).map(([v, n]) => ({ label: `${v} hair`, level: n! }))].sort((x, y) => x.level - y.level);
  const colour = (key: 'skin' | 'hair' | 'shirt' | 'pants', label: string) => (
    <Field label={label}>
      <input type="color" className="pc-color" value={a[key]} onChange={(ev) => set(key, ev.target.value)} />
    </Field>
  );
  const save = async () => {
    setBusy(true);
    const res = await act(() => api<Employee>('PATCH', `/employees/${e.id}`, { appearance: a }), 'Appearance saved');
    setBusy(false);
    if (res) setA(res.appearance);
  };
  const changed = (Object.keys(a) as Array<keyof Appearance>).filter((k) => a[k] !== e.appearance[k]);
  const WORD: Record<string, string> = { skin: 'skin', hair: 'hair colour', shirt: 'shirt', pants: 'trousers', hairStyle: 'hair style', accessory: 'accessory', build: 'build' };
  return (
    <div className="k-stack pf-form" data-profile-look>
      <div className="lk-cols">
        <div className="lk-face">
          <Avatar appearance={a} size={132} />
          <div className="k-sub" style={{ whiteSpace: 'normal', textAlign: 'center' }}>
            As they will look. The face shows skin, hair and shirt; the rest is seen on them in the office.
          </div>
        </div>
        <div className="k-stack">
          <section className="k-section">
            <div className="k-label">Colours</div>
            <div className="grid4">
              {colour('skin', 'Skin')}
              {colour('hair', 'Hair')}
              {colour('shirt', 'Shirt')}
              {colour('pants', 'Trousers')}
            </div>
          </section>
          <section className="k-section">
            <div className="k-label">Hair and what they wear</div>
            <div className="grid2">
              <Field label="Hair style">
                <select value={a.hairStyle} onChange={(ev) => set('hairStyle', ev.target.value as Appearance['hairStyle'])}>
                  {HAIR_STYLES.map((h) => {
                    const need = lockedAt('hairStyle', h);
                    return (
                      <option key={h} value={h} disabled={need != null}>
                        {h}
                        {need != null ? ` — unlocks at level ${need}` : ''}
                      </option>
                    );
                  })}
                </select>
              </Field>
              <Field label="Accessory">
                <select value={a.accessory} onChange={(ev) => set('accessory', ev.target.value as Appearance['accessory'])}>
                  {ACCESSORIES.map((x) => {
                    const need = lockedAt('accessory', x);
                    return (
                      <option key={x} value={x} disabled={need != null}>
                        {x}
                        {need != null ? ` — unlocks at level ${need}` : ''}
                      </option>
                    );
                  })}
                </select>
              </Field>
            </div>
            {/* What is earned with levels, in a sentence: what they have, and what comes next. */}
            <div className="k-sub look-locks" style={{ whiteSpace: 'normal' }} aria-label="Looks unlocked by level">
              {e.name} is level {e.level}. Some looks are earned with levels:{' '}
              {unlocks.map((u, i) => (
                <span key={u.label} title={e.level >= u.level ? 'Unlocked' : `Unlocks at level ${u.level}`} style={e.level >= u.level ? { color: 'var(--text)' } : undefined}>
                  {i > 0 ? ', ' : ''}
                  {u.label} at level {u.level}
                  {e.level >= u.level ? ' ✓' : ''}
                </span>
              ))}
              .
            </div>
          </section>
          <section className="k-section">
            <div className="k-label">Build</div>
            <Field label={`${a.build.toFixed(2)}× — how big they are in the office, 0.90 to 1.10`}>
              <input type="range" className="pc-range" min={0.9} max={1.1} step={0.01} value={a.build} onChange={(ev) => set('build', Number(ev.target.value))} />
            </Field>
          </section>
        </div>
      </div>
      <div className="pf-save" data-look-save>
        <div className="pf-save-note">{dirty ? `Unsaved: ${changed.map((k) => WORD[k] ?? k).join(', ')}. Everybody in the office sees it once it is saved.` : 'Nothing is changed.'}</div>
        <Button variant="ghost" className="k-quiet" disabled={!dirty || busy} onClick={() => setA(e.appearance)}>
          Discard
        </Button>
        <Button variant="primary" disabled={!dirty || busy} onClick={save}>
          Save appearance
        </Button>
      </div>
    </div>
  );
}

function UsageValue({ session }: { session: AgentSession }) {
  const u = session.usage;
  if (!u) {
    return (
      <span className="row row-wrap" style={{ gap: 6 }}>
        <span className="muted">{NOT_AVAILABLE}</span>
        <span className="small faint">{session.capabilities.usage ? 'no measurement has arrived yet' : 'this session has no readable transcript'}</span>
      </span>
    );
  }
  return (
    <span className="col" style={{ gap: 3 }}>
      <span className="row row-wrap" style={{ gap: 6 }}>
        <span>
          {fmtInt(u.inputTokens)} in · {fmtInt(u.outputTokens)} out · {fmtInt(u.cacheReadTokens)} cache read · {fmtInt(u.cacheCreationTokens)} cache write · {fmtInt(u.turns)} turns
        </span>
        <Provenance kind="measured" />
      </span>
      <span className="small faint">Summed from the Claude Code transcript on the machine, {timeAgo(u.measuredAt)}.</span>
    </span>
  );
}

function sessionStatusTone(status: AgentSession['status']): Tone {
  return status === 'running' ? 'good' : status === 'starting' ? 'info' : status === 'host_offline' ? 'warn' : status === 'lost' ? 'bad' : 'muted';
}

function SessionTab({ e }: { e: Employee }) {
  const sessions = useOffice((s) => s.sessions);
  const controlMap = useOffice((s) => s.control);
  const hosts = useOffice((s) => s.hosts);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const session = sessionOfEmployee(sessions, e.id);
  const live = isLive(session);
  const previous = Object.values(sessions)
    .filter((x) => x.employeeId === e.id && x.id !== session?.id)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const control = session ? (controlMap[session.id]?.control ?? session.control) : 'DISCONNECTED';
  const controlInfo = CONTROL_STATES.find((c) => c.id === control);
  const paused = control === 'PAUSED';
  const attached = session?.origin === 'attached';
  const host = e.hostId ? hosts[e.hostId] : undefined;
  const st = useOffice.getState();
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    await act(fn, ok);
    setBusy(false);
  };

  const state = employeeState(activityOf(session), false);
  return (
    <div className="k-stack" data-profile-session>
      <div className="k-text">
        A session is {e.name}'s Claude Code, running in a terminal on their machine. It starts by itself when they are given work or spoken to; here it is started, paused and stopped by hand.
      </div>
      <div className="k-actions">
        {live ? (
          <>
            {paused ? (
              <Button small disabled={busy} onClick={() => run(() => api('POST', `/employees/${e.id}/resume`, {}), `${e.name} resumed`)}>
                Resume
              </Button>
            ) : (
              <Button small disabled={busy} onClick={() => run(() => api('POST', `/employees/${e.id}/pause`, {}), `${e.name} paused`)} title="Stops what they are doing right now. They do nothing more until you resume them.">
                Pause
              </Button>
            )}
            <Button small disabled={busy} onClick={() => setConfirmStop(true)}>
              {attached ? 'Detach…' : 'Stop session…'}
            </Button>
          </>
        ) : (
          <Button variant="success" small disabled={busy || !e.hostId || e.archived} onClick={() => run(() => api('POST', `/employees/${e.id}/start`, {}), `${e.name}'s session is starting`)} title={!e.hostId ? 'Assign a machine first' : undefined}>
            {session?.lastEventAt ? 'Resume session' : 'Start session'}
          </Button>
        )}
        <Button small onClick={() => st.enterWorkstation(e.id)} disabled={!session}>
          Open terminal
        </Button>
        {!live && host && host.status !== 'online' && <span className="k-sub">{host.name} is {host.status}; a session cannot start there right now.</span>}
        {!live && !e.hostId && <span className="k-sub">No machine assigned.</span>}
      </div>

      {confirmStop && live && (
        <ConfirmBox
          title={attached ? `Detach ${e.name}'s session from the office?` : `Stop ${e.name}'s Claude Code session?`}
          confirmLabel={attached ? 'Detach session' : 'Stop session'}
          busy={busy}
          onCancel={() => setConfirmStop(false)}
          onConfirm={async () => {
            await run(() => api('POST', `/employees/${e.id}/stop`, {}), attached ? 'Session detached' : 'Session stopped');
            setConfirmStop(false);
          }}
        >
          {attached
            ? 'This session was not started by Orchestrator, so it is only detached: the tmux session keeps running on the machine and the office stops observing it.'
            : 'The Claude Code process in tmux is ended and any turn in progress is cut off. The conversation is kept and can be resumed later.'}
        </ConfirmBox>
      )}

      {!session ? (
        <div className="k-empty">
          <div className="k-title">No session yet</div>
          <div className="k-text">{e.name} has never had one. Start it here, or give them a task and the office starts it.</div>
        </div>
      ) : (
        <section className="k-section">
          <div className="k-label">{live ? 'The session now' : 'The last session'}</div>
          <div className="k-group">
            <div className="k-row k-row-sm">
              <span className={`k-dot ${live ? '' : 'k-dot-off'}`} aria-hidden />
              <span className="k-main">
                <span className="k-title k-title-sm">
                  {humanize(session.status)}
                  {live && <span className="k-title-note">{state.word}{session.inTurn == null ? '' : session.inTurn ? ' · in a turn' : ' · between turns'}</span>}
                </span>
                {live && session.activityDetail && <span className="k-sub k-mono">{session.activityDetail}</span>}
              </span>
              <span className="k-aside">{live ? `since ${timeAgo(session.startedAt)}` : session.endedAt ? `ended ${timeAgo(session.endedAt)}` : ''}</span>
            </div>
            <div className="k-row k-row-sm" title={controlInfo?.text}>
              <span className={`k-dot ${controlMap[session.id]?.you ? 'k-dot-busy' : 'k-dot-off'}`} aria-hidden />
              <span className="k-main">
                <span className="k-title k-title-sm">
                  {controlInfo?.label ?? humanize(control)}
                  {controlMap[session.id]?.you && <span className="k-title-note k-warn">you hold the keyboard</span>}
                </span>
                {controlInfo && <span className="k-sub" style={{ whiteSpace: 'normal' }}>{controlInfo.text}</span>}
              </span>
            </div>
          </div>
          <dl className="k-spec" style={{ marginTop: 8 }}>
            <div>
              <dt>Machine</dt>
              <dd>
                {hosts[session.hostId]?.name ?? 'unknown'}
                {hosts[session.hostId] && hosts[session.hostId]!.status !== 'online' && <span className="k-warn"> · {hosts[session.hostId]!.status}</span>}
              </dd>
            </div>
            <div>
              <dt>Thinks with</dt>
              <dd>
                {session.model ?? 'the default model'}
                {session.effort ? ` · ${session.effort} effort` : ''}
              </dd>
            </div>
            <div>
              <dt>Last heard from</dt>
              <dd>{session.lastEventAt ? timeAgo(session.lastEventAt) : <span className="muted">never</span>}</dd>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <dt>Folder</dt>
              <dd className="k-mono">{session.cwd}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd className="k-mono">{session.branch ?? <span className="muted">none detected</span>}</dd>
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <dt>Tokens used</dt>
              <dd>
                <UsageValue session={session} />
              </dd>
            </div>
            {session.exitReason && (
              <div style={{ gridColumn: '1 / -1' }}>
                <dt>Why it ended</dt>
                <dd>{session.exitReason}</dd>
              </div>
            )}
          </dl>
          <More summary="Technical details">
            <dl className="k-spec">
              <div style={{ gridColumn: '1 / -1' }}>
                <dt>How it runs</dt>
                <dd>
                  {runtimeLabel(session)}
                  {e.executionMode === 'managed_sdk' && session.mode !== 'managed_sdk' && live && <span className="k-warn" title="This employee is configured for the SDK-managed runtime, but the machine does not provide it, so the session was started as an interactive worker."> · fallback</span>}
                </dd>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <dt>What the office can do with it</dt>
                <dd>
                  <CapabilityBadges capabilities={session.capabilities} />
                  {!session.capabilities.hooks && <div className="k-sub" style={{ whiteSpace: 'normal' }}>Without hooks only the terminal can be observed: activity stays UNKNOWN and nothing is inferred.</div>}
                </dd>
              </div>
              <div>
                <dt>tmux session</dt>
                <dd className="k-mono">
                  {session.tmuxSession}
                  {session.tmuxPane ? ` · pane ${session.tmuxPane}` : ''} · {session.cols}×{session.rows}
                </dd>
              </div>
              <div>
                <dt>Process id</dt>
                <dd className="k-mono">{session.pid ?? <span className="muted">{NOT_AVAILABLE}</span>}</dd>
              </div>
              <div>
                <dt>Permission mode</dt>
                <dd className="k-mono">{session.permissionMode ?? <span className="muted">unknown</span>}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{fmtDateTime(session.startedAt)}</dd>
              </div>
              {session.endedAt && (
                <div>
                  <dt>Ended</dt>
                  <dd>{fmtDateTime(session.endedAt)}</dd>
                </div>
              )}
            </dl>
          </More>
        </section>
      )}

      {previous.length > 0 && (
        <More summary={`${previous.length} earlier session${previous.length === 1 ? '' : 's'}`}>
          <div className="k-group">
            {previous.map((x) => (
              <div key={x.id} className="k-row k-row-sm" title={`${x.tmuxSession} · ${x.cwd}`}>
                <span className="k-dot k-dot-off" aria-hidden />
                <span className="k-main">
                  <span className="k-title k-title-sm">
                    {fmtDateTime(x.startedAt)}
                    <span className="k-title-note">
                      {humanize(x.status)}
                      {x.endedAt ? ` · until ${fmtDateTime(x.endedAt)}` : ''}
                    </span>
                  </span>
                  {x.exitReason && <span className="k-sub">{x.exitReason}</span>}
                </span>
                <span className="k-aside">{x.usage ? `${fmtInt(x.usage.outputTokens)} tokens out` : ''}</span>
              </div>
            ))}
          </div>
        </More>
      )}
    </div>
  );
}

const DELIVERY_TONE: Record<DeliveryStatus, Tone> = { none: 'muted', queued: 'neutral', sent: 'info', confirmed: 'good', failed: 'bad' };
const DELIVERY_TIP: Record<DeliveryStatus, string> = {
  none: 'Not delivered into a session',
  queued: 'Waiting for the session to be between turns',
  sent: 'Written to the runtime; not yet acknowledged',
  confirmed: 'The runtime acknowledged it',
  failed: 'Could not be delivered',
};

/** How a message fared on its way into a session: a word, coloured only when it did not get there. */
const DELIVERY_WORD: Record<DeliveryStatus, { word: string; tone: 'calm' | 'warn' | 'bad' }> = {
  none: { word: 'not delivered', tone: 'calm' },
  queued: { word: 'waiting', tone: 'calm' },
  sent: { word: 'on its way', tone: 'calm' },
  confirmed: { word: 'arrived', tone: 'calm' },
  failed: { word: 'did not arrive', tone: 'bad' },
};

function MessageTab({ e }: { e: Employee }) {
  const messages = useOffice((s) => s.messages);
  const employees = useOffice((s) => s.employees);
  const [shown, setShown] = useState(40);
  const [open, setOpen] = useState<string | null>(null);
  const list = useMemo(
    () =>
      Object.values(messages)
        .filter((m) => m.toEmployeeId === e.id || (m.from.kind === 'employee' && m.from.id === e.id))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [messages, e.id],
  );
  return (
    <div className="k-stack" data-profile-messages>
      <div className="k-text">Everything said to and by {e.name}, newest first: by you, by other people and by other employees. To say something yourself, use Talk, above. A click on a line shows all of it.</div>
      {list.length === 0 && (
        <div className="k-empty">
          <div className="k-title">Nothing said yet</div>
          <div className="k-text">What you tell {e.name} in Talk, and what other employees tell them, is kept here.</div>
        </div>
      )}
      {byDay(list.slice(0, shown)).map((g) => (
        <section key={g.day} className="k-section">
          <div className="k-label">{g.day}</div>
          <div className="k-group">
            {g.rows.map((m) => {
              const outgoing = m.toEmployeeId !== e.id;
              const other = outgoing ? (employees[m.toEmployeeId]?.name ?? 'someone') : m.from.name;
              const fared = DELIVERY_WORD[m.delivery.status];
              const whole = open === m.id;
              return (
                <div key={m.id}>
                  <div className="k-row k-row-sm k-row-click" role="button" tabIndex={0} aria-expanded={whole} onClick={() => setOpen(whole ? null : m.id)} onKeyDown={(ev) => ev.target === ev.currentTarget && onActivate(() => setOpen(whole ? null : m.id))(ev)}>
                    <span className="k-main">
                      <span className="k-title k-title-sm">
                        {outgoing ? `To ${other}` : `From ${other}`}
                        <span className="k-title-note">{oneLine(m.body, 120)}</span>
                      </span>
                    </span>
                    <span className="k-aside" title={fmtDateTime(m.createdAt)}>
                      {timeAgo(m.createdAt)}
                    </span>
                    <State word={fared.word} tone={fared.tone} title={`${DELIVERY_TIP[m.delivery.status]}${m.delivery.via ? ` — via ${humanize(m.delivery.via)}` : ''}`} width={96} />
                    <span className="k-chev" aria-hidden />
                  </div>
                  {whole && (
                    <div className="k-detail" style={{ paddingLeft: 16, paddingTop: 0, gap: 8 }}>
                      <div className="pre" style={{ fontSize: 13 }}>
                        {m.body}
                      </div>
                      <div className="k-sub" style={{ whiteSpace: 'normal' }}>
                        {humanize(m.kind)} · {fmtDateTime(m.createdAt)}
                        {m.delivery.detail ? ` · ${m.delivery.detail}` : ''}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {list.length > shown && (
        <button type="button" className="k-link" style={{ alignSelf: 'flex-start' }} onClick={() => setShown((n) => n + 40)}>
          Show {Math.min(40, list.length - shown)} more
        </button>
      )}
    </div>
  );
}

function HistoryTab({ e }: { e: Employee }) {
  const [all, setAll] = useState(false);
  const load = useLoad<OrchestratorEvent[]>(`/events?employeeId=${encodeURIComponent(e.id)}&limit=300${all ? '&includeActivity=1' : ''}`);
  const rows = useMemo(() => (load.data ?? []).filter((x) => all || isLoudEvent(x)).sort((a, b) => b.seq - a.seq), [load.data, all]);
  const open = (x: OrchestratorEvent) => {
    const st = useOffice.getState();
    if (x.taskId && st.tasks[x.taskId]) st.openPanel('task', x.taskId);
  };
  const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="k-stack" data-profile-history>
      <div className="k-head">
        <div className="k-text">What {e.name} did and what was done with them, as the office recorded it — newest first. A line about a task opens it.</div>
        <Button small variant="ghost" className="k-quiet" onClick={load.reload} disabled={load.loading}>
          Refresh
        </Button>
      </div>
      <label className="check small" style={{ alignItems: 'center' }}>
        <input type="checkbox" style={{ margin: 0 }} checked={all} onChange={(ev) => setAll(ev.target.checked)} />
        <span className="k-sub">Also every small step (each tool they used, each signal from their session)</span>
      </label>
      <LoadState load={load} what="the history" />
      {load.data && rows.length === 0 && <div className="k-sub">Nothing recorded for {e.name} yet.</div>}
      {byDay(rows.map((x) => ({ ...x, createdAt: x.ts }))).map((g) => (
        <section key={g.day} className="k-section">
          <div className="k-label">{g.day}</div>
          <div className="k-group">
            {g.rows.map((x) => {
              const clickable = !!x.taskId && !!useOffice.getState().tasks[x.taskId];
              const tone = eventTone(x);
              const inner = (
                <>
                  <span className="k-key" title={fmtDateTime(x.ts)}>
                    {g.day === 'Earlier' ? new Date(x.ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) : clock(x.ts)}
                  </span>
                  <span className="k-main">
                    <span className={`k-title k-title-sm ${tone}`} style={{ fontWeight: 500 }}>
                      {x.summary}
                    </span>
                  </span>
                  <span className="k-aside" title={`${x.type}${x.source.detail ? ` — ${x.source.detail}` : ''}`}>
                    {x.source.kind === 'owner' ? 'by a person' : x.source.kind === 'hook' ? 'from their session' : x.source.kind === 'server' ? 'by the office' : `from ${humanize(x.source.kind)}`}
                  </span>
                </>
              );
              return clickable ? (
                <button key={x.id} type="button" className="k-row k-row-sm tbl-click" onClick={() => open(x)}>
                  {inner}
                </button>
              ) : (
                <div key={x.id} className="k-row k-row-sm">
                  {inner}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {rows.length >= 300 && <div className="k-sub">The last 300 are shown.</div>}
    </div>
  );
}

function DeskTab({ e }: { e: Employee }) {
  const layout = useOffice((s) => s.layout);
  const employees = useOffice((s) => s.employees);
  const unlocked = useUnlocked();
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(e.schedule.available);
  const [from, setFrom] = useState(e.schedule.from ?? '');
  const [to, setTo] = useState(e.schedule.to ?? '');
  const occupants = useMemo(() => occupantsByDesk(employees), [employees]);
  if (!layout) return null;
  const move = async (deskId: string) => {
    if (deskId === e.deskId || busy) return;
    const other = occupants.get(deskId);
    setBusy(true);
    await act(() => api('PATCH', `/employees/${e.id}`, { deskId }), other ? `${e.name} and ${other.name} swapped desks` : `${e.name} moved to desk ${deskId}`);
    setBusy(false);
  };
  const scheduleDirty = available !== e.schedule.available || from !== (e.schedule.from ?? '') || to !== (e.schedule.to ?? '');
  const saveSchedule = () => act(() => api('PATCH', `/employees/${e.id}`, { schedule: { available, ...(from ? { from } : {}), ...(to ? { to } : {}) } }), 'Schedule saved');
  return (
    <div className="k-stack" data-profile-desk>
      <section className="k-section">
        <div className="k-head">
          <div className="k-label">Where they sit</div>
          <select style={{ width: 'auto', maxWidth: 280 }} value={e.deskId ?? ''} disabled={busy || e.archived} onChange={(ev) => ev.target.value && void move(ev.target.value)} aria-label="Desk">
            {!e.deskId && <option value="">No desk</option>}
            {layout.desks.map((desk) => {
              const o = occupants.get(desk.id);
              return (
                <option key={desk.id} value={desk.id}>
                  {desk.id} · {desk.zone} — {o ? (o.id === e.id ? 'current' : `swap with ${o.name}`) : 'free'}
                </option>
              );
            })}
          </select>
        </div>
        <div className="k-text">{e.archived ? 'Archived employees have no desk.' : `Click a desk on the plan to move ${e.name} there. A desk somebody sits at swaps the two.`}</div>
        <OfficeSvg layout={layout} unlocked={unlocked} label="Desk picker" style={{ maxHeight: 340 }}>
          {layout.desks.map((desk) => {
            const o = occupants.get(desk.id);
            const mine = o?.id === e.id;
            const label = mine ? `Desk ${desk.id}: ${e.name} sits here` : o ? `Desk ${desk.id}: swap with ${o.name}` : `Desk ${desk.id}: free`;
            return (
              <g
                key={desk.id}
                className={`pc-map-pick ${mine ? 'pc-map-pick-mine' : o ? 'pc-map-pick-taken' : ''}`}
                role="button"
                tabIndex={e.archived ? -1 : 0}
                aria-label={label}
                aria-pressed={mine}
                onClick={() => !e.archived && void move(desk.id)}
                onKeyDown={onActivate(() => !e.archived && void move(desk.id))}
              >
                <title>{label}</title>
                <rect x={desk.x - DESK_SIZE.w / 2} y={desk.z - DESK_SIZE.d / 2} width={DESK_SIZE.w} height={DESK_SIZE.d} rx={0.12} />
                {o && (
                  <text x={desk.x} y={desk.z + 0.18} textAnchor="middle">
                    {initials(o.name)}
                  </text>
                )}
              </g>
            );
          })}
        </OfficeSvg>
        <div className="k-legend">
          <span>
            <i style={{ background: 'var(--accent-strong)' }} /> {e.name}
          </span>
          <span>
            <i style={{ background: '#3a3350' }} /> somebody else (their initials)
          </span>
          <span>
            <i style={{ background: '#232c3e', border: '1px solid rgba(255,255,255,0.3)' }} /> free
          </span>
        </div>
      </section>

      <section className="k-section">
        <div className="k-label">When they work</div>
        <label className="check" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={available} onChange={(ev) => setAvailable(ev.target.checked)} />
          <span>
            Available for work
            <br />
            <span className="k-sub" style={{ whiteSpace: 'normal' }}>When off, the office never starts work for {e.name} by itself. You can still give them tasks and start them by hand.</span>
          </span>
        </label>
        <div className="k-actions" style={{ alignItems: 'flex-end' }}>
          <div style={{ width: 140 }}>
            <Field label="From">
              <input type="time" className="pc-input" value={from} onChange={(ev) => setFrom(ev.target.value)} disabled={!available} />
            </Field>
          </div>
          <div style={{ width: 140 }}>
            <Field label="To">
              <input type="time" className="pc-input" value={to} onChange={(ev) => setTo(ev.target.value)} disabled={!available} />
            </Field>
          </div>
          <Button disabled={!scheduleDirty} onClick={saveSchedule}>
            Save schedule
          </Button>
          {(from || to) && (
            <Button
              variant="ghost"
              className="k-quiet"
              onClick={() => {
                setFrom('');
                setTo('');
              }}
            >
              Clear the hours
            </Button>
          )}
        </div>
        <div className="k-sub" style={{ whiteSpace: 'normal' }}>Hours are in the server's local time and need both ends (they may cross midnight). Left empty: always.</div>
      </section>
    </div>
  );
}

/** An employee as a visitor meets them: who they are, what they are on, and their terminal if it is a shared one. */
function VisitorCard({ e, session }: { e: Employee; session: AgentSession | undefined }) {
  const can = useAccess();
  const projects = useOffice((s) => s.projects);
  const tasks = useOffice((s) => s.tasks);
  const task = currentTaskOf(tasks, e.id);
  const watch = !!session && isLive(session) && e.roleKey !== 'foreman' && can.read(e.hostId);
  return (
    <div className="col" style={{ gap: 14, padding: 18 }} data-visitor-card>
      <dl className="kv">
        <dt>Role</dt>
        <dd>{roleByKey(e.roleKey)?.title ?? e.title}</dd>
        <dt>Project</dt>
        <dd>{(e.projectId && projects[e.projectId]?.name) || <span className="muted">none of the shared ones</span>}</dd>
        <dt>Working on</dt>
        <dd>{task ? `${task.key} · ${task.title}` : <span className="muted">nothing right now</span>}</dd>
        {e.skills.length > 0 && (
          <>
            <dt>Skills</dt>
            <dd>{e.skills.join(', ')}</dd>
          </>
        )}
        <dt>Level</dt>
        <dd>{e.level}</dd>
      </dl>
      <div className="row row-wrap">
        <Button small disabled={!watch} onClick={() => useOffice.getState().enterWorkstation(e.id)} title={watch ? 'Watch what they are doing' : e.roleKey === 'foreman' || !can.read(e.hostId) ? 'This terminal is not a shared one.' : 'They have no session running.'}>
          Watch terminal
        </Button>
      </div>
      <div className="small faint">You are visiting this office: you see who works here and how the shared work stands.</div>
    </div>
  );
}

/** One figure of somebody's verified work: the number, and what it counts. */
function Figure({ n, what }: { n: number; what: string }) {
  return (
    <div className="k-figure">
      <b>{fmtInt(n)}</b>
      <span>{what}</span>
    </div>
  );
}

/**
 * Somebody at a glance: what they are doing now and what waits on me, what they are (role, project, machine,
 * model, how much they may do alone), and what they have delivered. Everything here is read; changing it is the
 * Settings tab's.
 */
function OverviewTab({ e, onTab }: { e: Employee; onTab: (tab: TabId) => void }) {
  const st = useOffice();
  const me = st.me;
  const session = sessionOfEmployee(st.sessions, e.id);
  const live = isLive(session);
  const task = currentTaskOf(st.tasks, e.id);
  const asks = openQuestionsOf(st.questions, e.id);
  const project = e.projectId ? st.projects[e.projectId] : undefined;
  const also = (e.alsoProjectIds ?? []).map((id) => st.projects[id]).filter((p): p is NonNullable<typeof p> => !!p);
  const host = e.hostId ? st.hosts[e.hostId] : undefined;
  const gamification = st.settings?.gamification !== false;
  const info = levelInfo(e.xp, e.level);
  const autonomy = autonomyInfo(e.autonomy);
  const waiting = Object.values(st.tasks).filter((t) => t.assigneeId === e.id && t.kind !== 'review' && (t.status === 'READY' || t.status === 'BACKLOG')).length;
  const whose = whoseEmployee(st.hosts, me, e);
  const kept = e.keptBy?.id === me?.id;
  return (
    <div className="k-cols" data-profile-overview>
      <div className="k-stack">
        <section className="k-section">
          <div className="k-label">Right now</div>
          <div className="k-group">
            {asks.map((q) => (
              <button key={q.id} type="button" className="k-row k-row-sm k-notice-row" onClick={() => st.openPanel('question', q.id)} title={q.text}>
                <span className="k-dot k-dot-busy" aria-hidden />
                <span className="k-main">
                  <span className="k-title k-title-sm">{q.kind === 'permission' ? 'Asks to be allowed something' : 'Asks you something'}</span>
                  <span className="k-sub">{oneLine(q.text, 110)}</span>
                </span>
                <State word={q.kind === 'permission' ? 'Decide' : 'Answer'} tone="warn" />
              </button>
            ))}
            {task ? (
              <button type="button" className="k-row k-row-sm" onClick={() => st.openPanel('task', task.id)} title="Open the task">
                <span className="k-key">{task.key}</span>
                <span className="k-main">
                  <span className="k-title k-title-sm">{task.title}</span>
                  <span className="k-sub">the task they are on{waiting ? ` · ${waiting} more waiting` : ''}</span>
                </span>
              </button>
            ) : (
              <div className="k-row k-row-sm">
                <span className="k-main">
                  <span className="k-title k-title-sm">No task right now</span>
                  <span className="k-sub">{waiting ? `${waiting} waiting for them on the board` : 'Give them one from Tasks, or tell them what you want in Talk.'}</span>
                </span>
              </div>
            )}
            <button type="button" className="k-row k-row-sm" onClick={() => onTab('session')} title="The session: start, stop, what it can do">
              <span className={`k-dot ${live ? '' : 'k-dot-off'}`} aria-hidden />
              <span className="k-main">
                <span className="k-title k-title-sm">{live ? `Session ${session!.status}` : 'No session running'}</span>
                <span className="k-sub">{live ? `since ${timeAgo(session!.startedAt)}${host ? ` · on ${host.name}` : ''}` : 'Asleep at the desk: talking to them or giving them a task wakes them.'}</span>
              </span>
              <span className="k-aside">Session</span>
            </button>
          </div>
        </section>

        <section className="k-section">
          <div className="k-head">
            <div className="k-label">What they are</div>
            <button type="button" className="k-link" onClick={() => onTab('profile')}>
              Change
            </button>
          </div>
          <dl className="k-spec">
            <div>
              <dt>Role</dt>
              <dd>{e.title}</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>
                {project ? (
                  <button type="button" className="k-link k-link-strong" onClick={() => st.openPanel('projects', project.id)}>
                    {project.name}
                  </button>
                ) : (
                  <span className="muted">none</span>
                )}
                {also.length > 0 && <span className="muted"> · also {also.map((p) => p.name).join(', ')}</span>}
              </dd>
            </div>
            <div>
              <dt>Machine</dt>
              <dd>
                {host ? host.name : <span className="muted">none</span>}
                {host && host.status !== 'online' && <span className="k-warn"> · {host.status}</span>}
              </dd>
            </div>
            <div>
              <dt>Thinks with</dt>
              <dd>
                {e.model ?? 'the default model'}
                {e.effort ? ` · ${e.effort} effort` : ''}
              </dd>
            </div>
            <div title={`${autonomy.text}\n${autonomy.maps}`}>
              <dt>May do without asking</dt>
              <dd>
                {autonomy.label} <span className="muted">— {autonomy.text}</span>
              </dd>
            </div>
            <div>
              <dt>Whose</dt>
              <dd>
                {whose.kind === 'mine' ? (kept ? 'Shared, looked after by you' : 'Yours') : whose.kind === 'shared' ? (whose.keeper ? `The office's · ${whose.keeper} looks after them` : "The office's") : `${whose.name}'s`}
                {mayKeep(st.hosts, me, e) &&
                  (kept ? (
                    <button type="button" className="k-link" style={{ marginLeft: 8 }} onClick={() => act(() => api('POST', `/employees/${e.id}/give-back`, {}), `${e.name} is no longer among yours`)} title="Stop listing them among your own. They stay in the office as they are.">
                      Not mine
                    </button>
                  ) : !e.keptBy || me?.kind === 'owner' ? (
                    <button type="button" className="k-link" style={{ marginLeft: 8 }} onClick={() => act(() => api('POST', `/employees/${e.id}/keep`, {}), `${e.name} is among yours now`)} title={e.keptBy ? `${e.keptBy.name} looks after them now. As an owner you can take them over.` : 'List them among your own: in My work, under Mine, and in your team lead\'s team. They stay shared with the office.'}>
                      List among mine
                    </button>
                  ) : null)}
              </dd>
            </div>
            {e.skills.length > 0 && (
              <div style={{ gridColumn: '1 / -1' }}>
                <dt>Skills</dt>
                <dd>{e.skills.join(' · ')}</dd>
              </div>
            )}
          </dl>
        </section>
      </div>

      <div className="k-stack">
        <section className="k-section">
          <div className="k-label">Delivered</div>
          <div className="k-figures">
            <Figure n={e.stats.tasksCompleted} what="tasks completed" />
            <Figure n={e.stats.testsPassed} what="verifications passed" />
            <Figure n={e.stats.deliverablesAccepted} what="deliverables accepted" />
            <Figure n={e.stats.reviewsCompleted} what="reviews completed" />
            <Figure n={e.stats.bugsFixed} what="bugs fixed" />
            <Figure n={e.stats.assists} what="assists" />
          </div>
          <div className="k-sub" style={{ whiteSpace: 'normal' }}>
            Counted by the office from verified records, not reported by the employee. Joined {fmtDateTime(e.createdAt)}.
          </div>
        </section>
        {gamification && (
          <section className="k-section">
            <div className="k-label">Level</div>
            <div className="k-meter" style={{ width: '100%' }} title="Level reflects verified, delivered work in this office — not the capability of the underlying model">
              <div className="k-meter-top">
                <span>{levelLine(e.level, e.xp, info.next)}</span>
              </div>
              <div className="k-meter-bar">
                <i style={{ width: `${info.pct}%` }} />
              </div>
            </div>
            {e.badges.length > 0 && (
              <div className="k-chips">
                {e.badges.map((b) => (
                  <span key={b} className="k-chip k-chip-dot" style={{ cursor: 'default' }} title="Earned from verified work">
                    {humanize(b)}
                  </span>
                ))}
              </div>
            )}
            <More summary="Where the XP came from">
              <XpLedger e={e} />
            </More>
          </section>
        )}
      </div>
    </div>
  );
}

function EmployeePanel({ arg, onClose }: PanelProps) {
  const [id, tabArg] = (arg ?? '').split(':');
  const visitor = useOffice((s) => s.me?.role === 'visitor');
  const e = useOffice((s) => (id ? s.employees[id] : undefined));
  const sessions = useOffice((s) => s.sessions);
  const questions = useOffice((s) => s.questions);
  const tasks = useOffice((s) => s.tasks);
  const [tab, setTab] = useState<TabId>(TAB_ARG[tabArg ?? ''] ?? 'overview');
  useEffect(() => {
    setTab(TAB_ARG[tabArg ?? ''] ?? 'overview');
  }, [id, tabArg]);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo(0, 0);
  }, [tab, id]);
  if (!e) {
    return (
      <Window kit title="Employee" onClose={onClose} width={520}>
        <div className="k-empty">
          <div className="k-title">Employee not found</div>
          <div className="k-text">They may have been removed.</div>
        </div>
      </Window>
    );
  }
  const session = sessionOfEmployee(sessions, e.id);
  const open = openQuestionsOf(questions, e.id);
  const state = employeeState(activityOf(session), open.length > 0);
  const task = currentTaskOf(tasks, e.id);
  const st = useOffice.getState();
  // The head: who it is, and in the line under the name how they are and on what — the same line as in every list.
  const lead = <Avatar appearance={e.appearance} size={44} offline={!isLive(session)} />;
  const line = (
    <span className="k-line" data-profile-state>
      <State {...state} />
      <span className="k-sub">{task ? `${task.key} ${task.title}` : `${e.title} · ${e.department}`}</span>
    </span>
  );
  if (visitor) {
    return (
      <Window kit title={e.name} subtitle={line} lead={lead} onClose={onClose} width={520} flush>
        <VisitorCard e={e} session={session} />
      </Window>
    );
  }
  return (
    <Window
      kit
      title={e.name}
      subtitle={line}
      lead={lead}
      onClose={onClose}
      width={980}
      flush
      actions={
        <>
          <Button variant="ghost" className="k-quiet" onClick={() => st.enterWorkstation(e.id)} disabled={!session} title={session ? 'Sit at their real terminal' : 'No session yet'}>
            Terminal
          </Button>
          {/* One main button: answering them when they ask, talking to them otherwise. */}
          {open[0] ? (
            <>
              <Button onClick={() => st.openPanel('talk', e.id)}>Talk</Button>
              <Button variant="primary" onClick={() => st.openPanel('question', open[0]!.id)}>
                {open[0].kind === 'permission' ? 'Review approval request' : 'Answer their question'}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => st.openPanel('talk', e.id)}>
              Talk
            </Button>
          )}
        </>
      }
    >
      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'profile', label: 'Settings' },
          { id: 'appearance', label: 'Look' },
          { id: 'session', label: 'Session' },
          { id: 'message', label: 'Messages' },
          { id: 'history', label: 'History' },
          // The foreman has no desk to choose.
          ...(e.roleKey === 'foreman' ? [] : [{ id: 'desk' as const, label: 'Desk and hours' }]),
        ]}
      />
      <div className="k-body pf-body" key={e.id} ref={body} data-profile-tab={tab}>
        {tab === 'overview' && <OverviewTab e={e} onTab={setTab} />}
        {/* The two forms stay mounted so unsaved edits survive a look at another tab. */}
        <div hidden={tab !== 'profile'}>
          <ProfileTab e={e} onClose={onClose} />
        </div>
        <div hidden={tab !== 'appearance'}>
          <AppearanceTab e={e} />
        </div>
        {tab === 'session' && <SessionTab e={e} />}
        {tab === 'message' && <MessageTab e={e} />}
        {tab === 'history' && <HistoryTab e={e} />}
        {tab === 'desk' && e.roleKey !== 'foreman' && <DeskTab e={e} />}
      </div>
    </Window>
  );
}
registerPanel('employee', EmployeePanel);
