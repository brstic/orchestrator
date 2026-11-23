import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { gatherSecOf, reviewDefaultOf, reviewUsualOf, type Project, type ReviewBy, type Task, type TaskStatus } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Field, Stat, Tabs, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useAccess } from '../../lib/access.ts';
import { activityOf, currentTaskOf, openQuestionsOf, sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { OPEN_ORDER, byAttention, employeeState, taskState } from '../../lib/my-work.ts';
import { progressOf, projectsLine } from '../../lib/project-view.ts';
import { PickMany, State } from './kit.tsx';
import { ask } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { scoped, whoseLabel, whoseProject } from '../../lib/mine.ts';
import { ScopeSwitch, WhoseBadge, useScope } from '../mine.tsx';
import { TaskChip, activeEmployees, plural, stamp, useAction } from './tasks.tsx';
import { REVIEW_CHOICES } from './task-shared.tsx';
import { CheckFinder } from './check-finder.tsx';
import './panels-work.css';

type PanelProps = { arg: string | null; onClose: () => void };

const STATUS_TONE: Record<Project['status'], Tone> = { active: 'good', paused: 'warn', archived: 'muted' };
const NEW = 'new';

/**
 * An editable copy of server state. It follows the server while untouched and
 * keeps the owner's edits once they start typing.
 */
function useDraft<T>(source: T): [T, Dispatch<SetStateAction<T>>, boolean] {
  const key = JSON.stringify(source);
  const [draft, setDraft] = useState(source);
  const [baseKey, setBaseKey] = useState(key);
  if (key !== baseKey) {
    setBaseKey(key);
    if (JSON.stringify(draft) === baseKey) setDraft(source);
  }
  return [draft, setDraft, JSON.stringify(draft) !== key];
}

/** Tasks that count as project work (reviews are bookkeeping for another task). */
function workTasks(tasks: Record<string, Task>, projectId: string): Task[] {
  return Object.values(tasks).filter((t) => t.projectId === projectId && t.kind !== 'review');
}

// ───────────────────────────── overview ──────────────────────────────

/**
 * How a project stands, at a glance: how far it is, what is open in it and who is on each thing, who works on it,
 * and what was finished lately. What the project is (its description, repository, rules) is the other tabs'.
 */
function ProjectOverview({ project, onTab }: { project: Project; onTab: (tab: ProjectTab) => void }) {
  const s = useOffice();
  const tasks = workTasks(s.tasks, project.id);
  const progress = progressOf(tasks);
  const open = tasks.filter((t) => OPEN_ORDER.includes(t.status)).sort((x, y) => OPEN_ORDER.indexOf(x.status) - OPEN_ORDER.indexOf(y.status) || y.updatedAt.localeCompare(x.updatedAt));
  const done = tasks.filter((t) => t.status === 'DONE').sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
  const team = activeEmployees(s.employees).filter((e) => e.projectId === project.id || !!e.alsoProjectIds?.includes(project.id));
  const people = byAttention(team.map((e) => ({ name: e.name, e, state: employeeState(activityOf(sessionOfEmployee(s.sessions, e.id)), openQuestionsOf(s.questions, e.id).length > 0) })));
  const filtered = s.filter.projectId === project.id;
  const row = (t: Task, finished = false) => {
    const who = t.assigneeId ? s.employees[t.assigneeId] : undefined;
    const state = taskState(t.status);
    return (
      <button key={t.id} type="button" className="k-row k-row-sm" onClick={() => s.openPanel('task', t.id)} data-project-task={t.id} title={`${t.key} ${t.title} — ${who ? who.name : 'unassigned'}`}>
        <span className="k-key">{t.key}</span>
        <span className="k-main">
          <span className="k-title k-title-sm">{t.title}</span>
        </span>
        {finished ? <span className="k-aside">{timeAgo(t.updatedAt)}</span> : t.status !== 'IN_PROGRESS' && <State word={state.word} tone={state.tone} />}
        {who ? <Avatar appearance={who.appearance} size={22} /> : <span className="k-nobody" aria-label="unassigned" />}
      </button>
    );
  };
  return (
    <div className="k-stack" data-project-overview>
      {project.status === 'paused' && <div className="k-note">Paused: nobody is given any of its tasks until you resume it.</div>}
      <section className="k-section">
        <div className="k-label">How far it is</div>
        {progress.total === 0 ? (
          <div className="k-text">
            Nothing has been asked for here yet. <b>Plan</b> turns what you want into tasks; a single task is made on the board.
          </div>
        ) : (
          <>
            <div className="k-bar" role="img" aria-label={progress.line}>
              {progress.parts.map((part) => (
                <i key={part.part} className={`k-bar-${part.part}`} style={{ width: `${part.percent}%` }} title={`${part.n} ${part.word}`} />
              ))}
            </div>
            <div className="k-legend">
              {progress.parts.map((part) => (
                <span key={part.part}>
                  <i className={`k-bar-${part.part}`} aria-hidden />
                  {part.n} {part.word}
                </span>
              ))}
            </div>
          </>
        )}
      </section>

      <div className="k-cols">
        <section className="k-section">
          <div className="k-head">
            <div className="k-label">Open now</div>
            <button
              type="button"
              className="k-link"
              onClick={() => {
                s.setFilter({ projectId: project.id });
                s.openPanel('tasks');
              }}
            >
              Its tasks
            </button>
          </div>
          {open.length === 0 ? (
            <div className="k-sub">{progress.total ? 'Nothing is open: everything asked for is done.' : 'No task yet.'}</div>
          ) : (
            <div className="k-group">{open.slice(0, 8).map((t) => row(t))}</div>
          )}
          {open.length > 8 && <div className="k-sub">…and {open.length - 8} more on the board.</div>}
          {done.length > 0 && (
            <>
              <div className="k-label" style={{ marginTop: 12 }}>
                Done lately
              </div>
              <div className="k-group">{done.slice(0, 4).map((t) => row(t, true))}</div>
            </>
          )}
        </section>

        <section className="k-section">
          <div className="k-label">Who is on it · {team.length}</div>
          {team.length === 0 ? (
            <div className="k-text">
              Nobody yet. Hire somebody for it (<b>Team → Hire</b>), or give somebody this project in their Settings.
            </div>
          ) : (
            <div className="k-group">
              {people.map(({ e, state }) => {
                const task = currentTaskOf(s.tasks, e.id);
                return (
                  <button key={e.id} type="button" className="k-row k-row-sm" onClick={() => s.openPanel('employee', e.id)} title={`${e.title} — open their profile`}>
                    <Avatar appearance={e.appearance} size={24} offline={sessionOfEmployee(s.sessions, e.id)?.status !== 'running'} />
                    <span className="k-main">
                      <span className="k-title k-title-sm">{e.name}</span>
                    </span>
                    <span className="k-aside">{task && task.projectId === project.id ? task.key : ''}</span>
                    <State {...state} />
                  </button>
                );
              })}
            </div>
          )}
          <div className="k-label" style={{ marginTop: 12 }}>
            What it is
          </div>
          <div className="k-text" style={{ whiteSpace: 'pre-wrap' }}>
            {project.description.trim() || 'No description yet.'}
          </div>
          <div className="k-actions">
            <button type="button" className="k-link" onClick={() => onTab('about')}>
              Description, goals and repository
            </button>
          </div>
          <label className="check small" style={{ alignItems: 'center', marginTop: 4 }} title="Dims everyone else in the office and filters the task board">
            <input type="checkbox" style={{ margin: 0 }} checked={filtered} onChange={(e) => s.setFilter({ projectId: e.target.checked ? project.id : null })} />
            <span className="k-sub">Show only this project in the office</span>
          </label>
        </section>
      </div>
    </div>
  );
}

/** What a project is: its description, goals, requirements and notes — what employees are told — and where it lives. */
function ProjectAbout({ project }: { project: Project }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const [draft, setDraft, dirty] = useDraft({ description: project.description, goals: project.goals, requirements: project.requirements, docs: project.docs });
  const team = activeEmployees(s.employees).filter((e) => e.projectId === project.id || !!e.alsoProjectIds?.includes(project.id));
  const host = project.hostId ? s.hosts[project.hostId] : undefined;
  // Where this project's people actually work — derived, not configured.
  const machines = [...new Set([project.hostId, ...team.map((e) => e.hostId)].filter((x): x is string => !!x))].map((id) => s.hosts[id]).filter((h): h is NonNullable<typeof h> => !!h);
  const text = (key: keyof typeof draft, label: string, hint: string, minHeight: number) => (
    <Field label={label} hint={hint} wide={key === 'requirements' || key === 'docs'}>
      <textarea value={draft[key]} style={{ minHeight }} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
    </Field>
  );
  return (
    <div className="k-stack" data-project-about>
      <div className="k-text">What employees on this project are told about it. They read it through their project context, at the start of every session.</div>
      <form
        className="pw-form"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (dirty) void run(() => api('PATCH', `/projects/${project.id}`, draft), 'Project saved');
        }}
      >
        {text('description', 'Description', 'What this project is.', 70)}
        {text('goals', 'Goals', 'Objectives you plan are added here.', 70)}
        {text('requirements', 'Requirements', 'What must hold when it is done.', 110)}
        {text('docs', 'Docs and notes', 'Conventions, links, anything the team should know.', 90)}
        <div className="k-actions field-wide">
          <Button variant="primary" type="submit" disabled={busy || !dirty}>
            Save changes
          </Button>
          {dirty && (
            <Button variant="ghost" className="k-quiet" type="button" onClick={() => setDraft({ description: project.description, goals: project.goals, requirements: project.requirements, docs: project.docs })}>
              Discard
            </Button>
          )}
        </div>
      </form>

      <section className="k-section">
        <div className="k-label">Where it lives</div>
        <dl className="k-spec">
          <div style={{ gridColumn: '1 / -1' }}>
            <dt>Folder</dt>
            <dd className="k-mono">{project.repoPath ?? <span className="muted">no repository set</span>}</dd>
          </div>
          <div>
            <dt>On</dt>
            <dd>
              {host ? host.name : <span className="muted">{project.hostId ? 'an unknown machine' : 'no machine'}</span>}
              {host && host.status !== 'online' && <span className="k-warn"> · {host.status}</span>}
            </dd>
          </div>
          <div>
            <dt>Base branch</dt>
            <dd className="k-mono">{project.baseBranch}</dd>
          </div>
          <div>
            <dt>Integration branch</dt>
            <dd className="k-mono">{project.integrationBranch}</dd>
          </div>
          <div>
            <dt>Machines its people work on</dt>
            <dd>{machines.length ? machines.map((m) => `${m.name}${m.status === 'online' ? '' : ` (${m.status})`}`).join(', ') : <span className="muted">none yet</span>}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{stamp(project.createdAt)}</dd>
          </div>
        </dl>
      </section>
      <ProjectLinks project={project} />
    </div>
  );
}

/** A project's other repositories and the projects it builds on. */
function ProjectLinks({ project }: { project: Project }) {
  const projects = useOffice((s) => s.projects);
  const [busy, run] = useAction();
  const [draft, setDraft, dirty] = useDraft({ repos: (project.extraRepos ?? []).map((r) => r.path).join('\n'), dependsOn: project.dependsOn ?? [] });
  const others = Object.values(projects).filter((p) => p.id !== project.id && p.status !== 'archived');
  const repos = [...new Set(draft.repos.split('\n').map((l) => l.trim()).filter(Boolean))];
  const bad = repos.filter((r) => !r.startsWith('/'));
  const save = (ev: FormEvent) => {
    ev.preventDefault();
    if (!dirty || bad.length) return;
    void run(() => api('PATCH', `/projects/${project.id}`, { extraRepos: repos.map((path) => ({ path })), dependsOn: draft.dependsOn }), 'Saved — sessions started from now on get the repositories');
  };
  return (
    <form className="col" style={{ gap: 10 }} onSubmit={save}>
      <div className="section-title" style={{ margin: 0 }}>
        Other repositories and dependencies
      </div>
      <Field label="Other repositories of this project" hint={bad.length ? `Absolute paths only: ${bad.join(', ')}` : 'One folder per line, on the same machine as the main repository. Sessions on this project can read and change them too (claude --add-dir); they must be inside the machine’s allowed folders.'}>
        <textarea className="mono" value={draft.repos} onChange={(e) => setDraft({ ...draft, repos: e.target.value })} placeholder="/home/me/projects/shared-ui" spellCheck={false} style={{ minHeight: 48 }} />
      </Field>
      <div>
        <div className="field-label">Builds on</div>
        {others.length === 0 ? (
          <div className="small faint">There are no other projects.</div>
        ) : (
          <PickMany
            name="builds-on"
            add="Add a project"
            none="Nothing"
            options={others.map((o) => ({ id: o.id, label: o.name, hint: o.deliveredAt ? 'delivered' : 'not delivered', lead: <i className="k-swatch" style={{ background: o.color }} /> }))}
            value={draft.dependsOn}
            onChange={(ids) => setDraft({ ...draft, dependsOn: ids })}
          />
        )}
        <div className="field-hint">Employees are told which projects this one builds on, where they live and whether they are delivered. It does not hold tasks back.</div>
      </div>
      <div className="row">
        <Button variant="primary" type="submit" disabled={!dirty || busy || bad.length > 0}>
          Save
        </Button>
      </div>
    </form>
  );
}

// ────────────────────────────── policy ───────────────────────────────

const toLines = (text: string): string[] => [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];

function invalidRegexes(patterns: string[]): string[] {
  return patterns.filter((p) => {
    try {
      new RegExp(p);
      return false;
    } catch {
      return true;
    }
  });
}

/** For how long a project gathers what its employees write to each other (`ProjectPolicy.gatherSec`). */
const GATHER_CHOICES: [string, string][] = [
  ['0', 'At once'],
  ['30', 'Gathered for 30 seconds'],
  ['60', 'Gathered for a minute'],
  ['120', 'Gathered for two minutes'],
  ['300', 'Gathered for five minutes'],
];
/** How many checks a way of reviewing is: fewer than before is asked about when it is saved. */
const REVIEW_WEIGHT: Record<ReviewBy, number> = { none: 0, peer: 1, boss: 1, both: 2 };
const reviewLabel = (r: ReviewBy) => REVIEW_CHOICES.find((c) => c.id === r)!.label;

function ProjectPolicyTab({ project }: { project: Project }) {
  const [busy, run] = useAction();
  const settings = useOffice((s) => s.settings);
  const p = project.policy;
  const [draft, setDraft, dirty] = useDraft({
    verifyCommand: project.verifyCommand ?? '',
    verifyTimeoutSec: String(project.verifyTimeoutSec),
    autoAssign: p.autoAssign,
    requireReview: p.requireReview,
    review: (p.review ?? '') as ReviewBy | '',
    gatherSec: String(gatherSecOf(project)),
    autoMerge: p.autoMerge,
    integrationTests: p.integrationTests !== false,
    oneAtATime: p.oneAtATime === true,
    allow: p.allow.join('\n'),
    deny: p.deny.join('\n'),
    highRisk: p.highRiskPatterns.join('\n'),
  });
  const set = (patch: Partial<typeof draft>) => setDraft({ ...draft, ...patch });
  const allow = toLines(draft.allow);
  const deny = toLines(draft.deny);
  const highRisk = toLines(draft.highRisk);
  const badRegexes = invalidRegexes(highRisk);
  const timeout = Number(draft.verifyTimeoutSec);
  const timeoutOk = Number.isInteger(timeout) && timeout > 0;
  // How this project's work is reviewed: its own way, or the office's while none is chosen.
  const officeReview = reviewDefaultOf(settings);
  const reviewWas = reviewUsualOf(settings, project);
  const reviewNow: ReviewBy = draft.review || officeReview;

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!dirty || !timeoutOk || badRegexes.length) return;
    // Anything that lets agents do more without asking is spelled out before it is saved.
    const widening = [
      ...allow.filter((r) => !p.allow.includes(r)).map((r) => `allow  ${r}`),
      ...p.deny.filter((r) => !deny.includes(r)).map((r) => `no longer denied  ${r}`),
      ...p.highRiskPatterns.filter((r) => !highRisk.includes(r)).map((r) => `no longer needs approval  ${r}`),
      // Fewer eyes on finished work than there were is said the same way.
      ...(REVIEW_WEIGHT[reviewNow] < REVIEW_WEIGHT[reviewWas] ? [`finished work reviewed by: ${reviewLabel(reviewNow)}  (was: ${reviewLabel(reviewWas)})`] : []),
    ];
    if (widening.length && !(await ask({ title: `Let employees on "${project.name}" do more without asking?`, body: `${widening.join('\n')}\n\nThis takes effect for sessions started from now on.`, ok: 'Save the rules' }))) return;
    void run(
      () =>
        api('PATCH', `/projects/${project.id}`, {
          verifyCommand: draft.verifyCommand.trim() || null,
          verifyTimeoutSec: timeout,
          policy: { allow, deny, highRiskPatterns: highRisk, autoAssign: draft.autoAssign, requireReview: draft.requireReview, review: draft.review || null, gatherSec: Number(draft.gatherSec) || null, autoMerge: draft.autoMerge, integrationTests: draft.integrationTests, oneAtATime: draft.oneAtATime },
        }),
      'Policy saved',
    );
  };
  const check = (key: 'autoAssign' | 'requireReview' | 'autoMerge' | 'integrationTests' | 'oneAtATime', label: string, explain: string) => (
    <label className="check field-wide">
      <input type="checkbox" checked={draft[key]} onChange={(e) => set({ [key]: e.target.checked })} />
      <span>
        <span className="strong">{label}</span>
        <br />
        <span className="field-hint">{explain}</span>
      </span>
    </label>
  );
  const rules = (key: 'allow' | 'deny' | 'highRisk', label: string, hint: string, placeholder: string) => (
    <Field label={label} hint={hint} wide>
      <textarea className="mono" value={draft[key]} placeholder={placeholder} spellCheck={false} onChange={(e) => set({ [key]: e.target.value })} />
    </Field>
  );

  return (
    <form className="k-stack pf-form" onSubmit={save} data-project-policy>
      <section className="k-section">
        <div className="k-label">When a task is handed in</div>
        <div className="pw-form">
          <Field label="Verification command" hint="Run by the office on the machine after an employee says a task is complete. Empty: nothing is run.">
            <input className="mono" value={draft.verifyCommand} placeholder="npm test" spellCheck={false} onChange={(e) => set({ verifyCommand: e.target.value })} />
            <CheckFinder projectId={project.id} value={draft.verifyCommand} onPick={(command) => set({ verifyCommand: command })} />
          </Field>
          <Field label="Verification timeout (seconds)" hint={timeoutOk ? 'The command is stopped and counted as failed after this long.' : 'Enter a whole number of seconds greater than zero.'}>
            <input type="number" min={1} step={1} value={draft.verifyTimeoutSec} onChange={(e) => set({ verifyTimeoutSec: e.target.value })} />
          </Field>
          <Field label="Finished work is reviewed by" hint={`${draft.review ? REVIEW_CHOICES.find((c) => c.id === draft.review)!.hint : `This project follows the office: ${reviewLabel(officeReview).toLowerCase()}.`} What every new task of this project starts with, whoever makes it; a task can still be set differently, and tasks that exist keep what they have.`}>
            <select aria-label="Finished work of this project is reviewed by" data-project-review value={draft.review} onChange={(e) => set({ review: e.target.value as ReviewBy | '' })}>
              <option value="">As the office ({reviewLabel(officeReview).toLowerCase()})</option>
              {REVIEW_CHOICES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Colleagues' messages reach an idle employee" hint="What employees of this project write to each other (messages, comments on a ticket) can be gathered, so that several arrive in one turn instead of one turn each — every turn of an idle session costs usage. A person's words, tasks, answers and requests somebody waits on always go at once.">
            <select aria-label="Colleagues' messages reach an idle employee" data-project-gather value={draft.gatherSec} onChange={(e) => set({ gatherSec: e.target.value })}>
              {GATHER_CHOICES.concat(GATHER_CHOICES.some(([v]) => v === draft.gatherSec) ? [] : [[draft.gatherSec, `Gathered for ${draft.gatherSec} seconds`]]).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          {!draft.review && officeReview === 'none' && check('requireReview', 'Require review', 'Code tasks created from now on need an approved review before they count as done.')}
          {check('integrationTests', 'Integration tests', 'After every merge the verification command also runs on the integration branch itself, so work that passes alone but breaks together is caught.')}
        </div>
      </section>

      <section className="k-section">
        <div className="k-label">What happens by itself</div>
        <div className="pw-form">
          {check('autoAssign', 'Auto-assign', 'Ready tasks start on their own when a matching employee is free, and tasks proposed by employees are released without waiting for you.')}
          {check('autoMerge', 'Auto-merge', 'Verified work is merged into the integration branch automatically.')}
          {check('oneAtATime', 'One at a time in a shared folder', 'Off (the default): employees who work in the same folder work side by side; each is told who else is there, and a task counts only the files its own session wrote. On: the next task for a folder somebody is changing waits its turn.')}
        </div>
      </section>

      <section className="k-section">
        <div className="k-label">What employees may run here</div>
        <div className="pw-form">
          {rules('allow', 'Allow rules', 'One Claude Code permission rule per line. Matching tools run without asking you.', 'Bash(npm test:*)')}
          {rules('deny', 'Deny rules', 'One rule per line. Matching tools are refused outright.', 'Bash(git push:*)')}
          {rules('highRisk', 'Extra high-risk patterns', 'One regular expression per line. Matching shell commands always need your approval, in addition to the built-in ones.', 'terraform\\s+apply')}
          {badRegexes.length > 0 && <div className="pw-error field-wide">Not a valid regular expression: {badRegexes.join('   ')}</div>}
        </div>
      </section>

      <div className="pf-save" data-policy-save>
        <div className="pf-save-note">{dirty ? 'Unsaved changes. The rules reach a session when it starts: after saving, restart whoever should follow the new ones.' : 'Nothing is changed. The rules reach a session when it starts.'}</div>
        <Button variant="primary" type="submit" disabled={busy || !dirty || !timeoutOk || badRegexes.length > 0}>
          Save policy
        </Button>
      </div>
    </form>
  );
}

// ─────────────────────────────── plan ────────────────────────────────

function ProjectPlan({ project }: { project: Project }) {
  const s = useOffice();
  const [busy, run] = useAction();
  const rank = (roleKey: string) => (roleKey === 'architect' ? 0 : roleKey === 'pm' ? 1 : 2);
  const planners = activeEmployees(s.employees).sort((a, b) => rank(a.roleKey) - rank(b.roleKey));
  const [plannerId, setPlannerId] = useState(planners[0]?.id ?? '');
  const [objective, setObjective] = useState('');
  const planning = workTasks(s.tasks, project.id)
    .filter((t) => t.kind === 'planning')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!objective.trim() || !plannerId || busy) return;
    const task = await run(() => api<Task>('POST', `/projects/${project.id}/plan`, { objective, plannerId }));
    if (task) {
      s.toast(`${task.key} created: ${s.employees[plannerId]?.name ?? 'the planner'} will plan this`, 'success');
      setObjective('');
    }
  };

  if (!planners.length) {
    return (
      <div className="k-empty">
        <div className="k-title">Nobody to plan with</div>
        <div className="k-text">A plan is made by an employee: their session reads the project and proposes the tasks.</div>
        <Button onClick={() => s.openPanel('team', 'hire')}>Hire somebody</Button>
      </div>
    );
  }
  return (
    <div className="k-stack" data-project-plan>
      <div className="k-text">
        Say what you want built or changed. The planner gets it as a real task: their Claude Code session reads the requirements, looks through the repository and proposes the tasks, which appear on the board. What you write is also added to the
        project's goals.{' '}
        {project.policy.autoAssign ? 'Auto-assign is on for this project, so the proposed tasks are released and start on their own.' : 'Auto-assign is off for this project, so the proposed tasks wait on the board as “proposed” until you release them.'}
      </div>
      <form className="k-form" onSubmit={submit}>
        <Field label="What you want">
          <textarea value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What should be built or changed, in your own words." style={{ minHeight: 110 }} autoFocus aria-label="Objective" />
        </Field>
        <Field label="Who plans it" hint="Architects and project managers are listed first.">
          <select value={plannerId} onChange={(e) => setPlannerId(e.target.value)} aria-label="Planner">
            {planners.map((e) => {
              const status = sessionOfEmployee(s.sessions, e.id)?.status;
              return (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.title}
                  {status === 'running' || status === 'starting' ? '' : ' (asleep: this wakes them)'}
                </option>
              );
            })}
          </select>
        </Field>
        <div className="k-actions">
          <Button variant="primary" type="submit" disabled={busy || !objective.trim() || !plannerId}>
            Ask for a plan
          </Button>
          {project.status !== 'active' && <span className="k-sub">The project is {project.status}: the planning task waits until it is active.</span>}
        </div>
      </form>
      {planning.length > 0 && (
        <section className="k-section">
          <div className="k-label">Plans asked for so far</div>
          <div className="k-actions">
            {planning.map((t) => (
              <TaskChip key={t.id} id={t.id} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ──────────────────────────── new project ────────────────────────────

function ProjectCreate({ onCreated }: { onCreated: (id: string) => void }) {
  const s = useOffice();
  const hosts = Object.values(s.hosts)
    .filter((h) => h.status === 'online')
    .sort((a, b) => a.name.localeCompare(b.name));
  const [form, setForm] = useState({ name: '', description: '', hostId: '', repoPath: '', verifyCommand: '', requirements: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!form.name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api<Project>('POST', '/projects', { ...form, hostId: form.hostId || null, repoPath: form.repoPath.trim() || null });
      s.toast(`Project "${project.name}" created`, 'success');
      onCreated(project.id);
    } catch (e) {
      // Shown exactly as the server (or the host that checked the path) put it.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="pw-form" onSubmit={submit}>
      <div className="field-wide">
        <div className="strong" style={{ fontSize: 15 }}>
          New project
        </div>
        <div className="small muted">A project ties tasks to a repository on one of your machines and to the rules its sessions run under.</div>
      </div>
      <Field label="Name" wide>
        <input value={form.name} onChange={(e) => set({ name: e.target.value })} autoFocus required />
      </Field>
      <Field label="Description" wide>
        <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} style={{ minHeight: 56 }} />
      </Field>
      <Field label="Host" hint={hosts.length ? 'Only machines that are online can check the path.' : 'No machine is online, so a repository path cannot be checked right now.'}>
        <select value={form.hostId} onChange={(e) => set({ hostId: e.target.value })}>
          <option value="">First online machine</option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
              {h.local ? ' (this machine)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Repository path" hint="Checked on the host when you create the project. Leave empty for a project without a repository.">
        <input className="mono" value={form.repoPath} onChange={(e) => set({ repoPath: e.target.value })} placeholder="/home/you/code/app" spellCheck={false} />
      </Field>
      <Field label="Verification command" hint="Orchestrator runs it on the host to check completed work." wide>
        <input className="mono" value={form.verifyCommand} onChange={(e) => set({ verifyCommand: e.target.value })} placeholder="npm test" spellCheck={false} />
      </Field>
      <Field label="Requirements" wide>
        <textarea value={form.requirements} onChange={(e) => set({ requirements: e.target.value })} placeholder="What the product must do. Employees read this through their project context." style={{ minHeight: 110 }} />
      </Field>
      {error && (
        <div className="pw-error field-wide" role="alert">
          {error}
        </div>
      )}
      <div className="row field-wide">
        <Button variant="primary" type="submit" disabled={busy || !form.name.trim()}>
          {busy ? 'Checking…' : 'Create project'}
        </Button>
      </div>
    </form>
  );
}

// ─────────────────────────────── panel ───────────────────────────────

type ProjectTab = 'overview' | 'about' | 'integration' | 'policy' | 'plan';
/** What the tabs that are forms are for (the Overview, About and Plan say it themselves). */
const TAB_ABOUT: Partial<Record<ProjectTab, string>> = {
  integration: 'Where finished work comes together: every task that passes is merged into one branch, tested there, and promoted to the main branch when you say so.',
  policy: 'The rules of this project: how a finished task is checked, whether tasks start and merge by themselves, and what employees may and may not run here.',
};

interface IntegrationView {
  base: string;
  integration: string;
  baseHead: string | null;
  integrationHead: string | null;
  ahead: number;
  behind: number;
  baseCheckout: string | null;
  baseDirty: boolean;
  integrationTests: boolean;
  lastTest: NonNullable<Project['integration']>['lastTest'];
  lastPromotion: NonNullable<Project['integration']>['lastPromotion'];
}

/**
 * The integration branch of a shared project: how it stands against the base branch, whether it
 * passes its tests, and the owner's controls — bring the base in, test now, promote to the base.
 */
function ProjectIntegration({ project }: { project: Project }) {
  const [busy, run] = useAction();
  const [view, setView] = useState<IntegrationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stamp = `${project.integration?.lastTest?.ts ?? ''}|${project.integration?.lastPromotion?.ts ?? ''}`;
  const load = () =>
    api<IntegrationView>('GET', `/projects/${project.id}/integration`).then(
      (v) => {
        setView(v);
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
  useEffect(() => {
    setView(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, stamp]);

  if (project.workspace === 'in_place')
    return (
      <div className="k-empty">
        <div className="k-title">Worked on in place</div>
        <div className="k-text">{project.name} is one employee working directly in its folder, on the branch that is checked out there. There is no integration branch: nothing is merged or promoted by the office.</div>
      </div>
    );
  if (error)
    return (
      <div className="k-empty">
        <div className="k-title">Integration status is not available</div>
        <div className="k-text">{error}</div>
      </div>
    );
  if (!view) return <div className="k-sub">Reading the repository…</div>;
  const t = view.lastTest;
  const act2 = (fn: () => Promise<unknown>, ok: string) => run(fn, ok).then(() => load());
  const promote = async () => {
    const red = t?.passed === false;
    const where = view.baseCheckout ? `It is checked out in ${view.baseCheckout}, so those files change on disk.` : 'It is not checked out anywhere, so only the branch moves.';
    if (!(await ask({ title: `Move ${view.base} forward by ${view.ahead} commit${view.ahead === 1 ? '' : 's'}?`, body: `${view.base} then matches ${view.integration}. ${where} Nothing is pushed.${red ? '\n\nThe integration tests are FAILING.' : ''}`, ok: red ? 'Promote anyway' : 'Promote', danger: red }))) return;
    void act2(() => api('POST', `/projects/${project.id}/promote`, { force: red }), `${view.base} now has the integrated work`);
  };
  const testWord = !view.integrationTests ? 'off' : !t ? 'not run' : t.passed ? 'passing' : t.passed === false ? 'failing' : 'could not run';
  return (
    <div className="k-stack" data-project-integration>
      <div className="k-figures">
        <div className="k-figure" title={`commits on ${view.integration} not yet on ${view.base}`}>
          <b>{view.ahead}</b>
          <span>finished and waiting to go to {view.base}</span>
        </div>
        <div className="k-figure" title={`commits on ${view.base} that ${view.integration} lacks`}>
          <b className={view.behind ? 'k-warn' : ''}>{view.behind}</b>
          <span>on {view.base} and not brought in yet</span>
        </div>
        <div className="k-figure">
          <b className={t?.passed ? '' : t?.passed === false ? 'k-bad' : ''} style={{ fontSize: 17, lineHeight: '26px' }}>
            {testWord}
          </b>
          <span>integration tests{t ? ` · ${t.after} · ${timeAgo(t.ts)}` : view.integrationTests ? ' · they run after each merge' : project.verifyCommand ? ' · switched off in Policy' : ' · no verification command'}</span>
        </div>
      </div>
      <div className="k-actions">
        <Button disabled={busy || view.behind === 0} title={view.behind ? `Merge ${view.base} into ${view.integration} (aborted if it conflicts), then test` : `${view.integration} already has everything on ${view.base}`} onClick={() => void act2(() => api('POST', `/projects/${project.id}/integration/sync`, {}), `${view.base} brought into the integration branch`)}>
          Bring in {view.base}
        </Button>
        <Button disabled={busy || !project.verifyCommand} title={project.verifyCommand ? `Run "${project.verifyCommand}" on ${view.integration} now` : 'Set a verification command in Policy first'} onClick={() => void act2(() => api('POST', `/projects/${project.id}/integration/test`, {}), 'Integration tests finished')}>
          Test now
        </Button>
        <Button variant={t?.passed === false ? 'danger' : 'primary'} disabled={busy || view.ahead === 0 || view.behind > 0 || view.baseDirty} title={view.ahead === 0 ? 'Nothing to promote' : view.behind > 0 ? `Bring in ${view.base} first` : view.baseDirty ? `${view.base} has uncommitted changes` : `Move ${view.base} forward to the integrated work`} onClick={promote}>
          Promote to {view.base}
        </Button>
      </div>
      <div className="k-text">
        Finished tasks are merged into <span className="k-mono">{view.integration}</span>. Promoting moves <span className="k-mono">{view.base}</span> forward to it, on this machine; the office never pushes.
      </div>
      {view.baseDirty && (
        <div className="k-note">
          {view.base} is checked out in {view.baseCheckout} with uncommitted changes — commit or stash them before promoting.
        </div>
      )}
      {t && (
        <section className="k-section">
          <div className="k-label">The last integration test</div>
          <div className="k-sub" style={{ whiteSpace: 'normal' }}>
            <span className="k-mono">{t.command}</span> on {t.sha ? t.sha.slice(0, 8) : 'an unknown commit'}
          </div>
          <pre className="k-code" style={{ maxHeight: 220, overflow: 'auto', padding: '12px 14px', margin: 0 }}>
            {t.outputTail.trim() || (t.passed ? '(no output)' : '(no output; the command failed)')}
          </pre>
        </section>
      )}
      {view.lastPromotion && (
        <div className="k-sub">
          Last promoted {timeAgo(view.lastPromotion.ts)}: {view.lastPromotion.commits} commit{view.lastPromotion.commits === 1 ? '' : 's'}, to {view.lastPromotion.sha.slice(0, 8)}.
        </div>
      )}
    </div>
  );
}

/** One project: its name and how it stands, what can be done with it as a whole, and its tabs. */
function ProjectDetail({ project }: { project: Project }) {
  const s = useOffice();
  const can = useAccess();
  const [busy, run] = useAction();
  const [tab, setTab] = useState<ProjectTab>('overview');
  const tasks = workTasks(s.tasks, project.id);
  const inProgress = tasks.filter((t) => t.status === 'IN_PROGRESS').length;
  const pause = async () => {
    // Stopping people mid-task is worth a question; pausing a project nobody is working on is not.
    if (inProgress && !(await ask({ title: `Pause ${project.name}?`, body: `${plural(inProgress, 'task')} in progress will be stopped where they are and wait. Nothing new starts until you resume.`, ok: 'Pause project' }))) return;
    const res = await run(() => api<{ interrupted: number }>('POST', `/projects/${project.id}/pause`, {}));
    if (res) s.toast(`${project.name} paused${res.interrupted ? `: ${plural(res.interrupted, 'task')} stopped and waiting` : ''}`, 'success');
  };

  const remove = async () => {
    const all = Object.values(s.tasks).filter((t) => t.projectId === project.id);
    const running = all.filter((t) => t.status === 'IN_PROGRESS').length;
    const staying = activeEmployees(s.employees).filter((e) => e.projectId === project.id).map((e) => e.name);
    const body = [
      all.length ? `Its ${plural(all.length, 'task')} ${all.length === 1 ? 'is' : 'are'} deleted with it${running ? ` — ${running} in progress ${running === 1 ? 'is' : 'are'} stopped first` : ''}.` : 'It has no tasks.',
      staying.length ? `${staying.join(', ')} ${staying.length === 1 ? 'stays' : 'stay'} in the office, without a project.` : '',
      `Nothing on disk is touched${project.repoPath ? `: ${project.repoPath} stays exactly as it is` : ''}.`,
      'This cannot be undone.',
    ]
      .filter(Boolean)
      .join(' ');
    if (!(await ask({ title: `Delete ${project.name}?`, body, ok: 'Delete project', danger: true }))) return;
    const res = await run(() => api<{ name: string }>('DELETE', `/projects/${project.id}`));
    if (!res) return;
    if (s.filter.projectId === project.id) s.setFilter({ projectId: null });
    s.toast(`${res.name} deleted`, 'success');
  };

  return (
    <div className="pj-detail">
      <div className="pj-head" data-project-head>
        <span className="k-dot" style={{ background: project.color, boxShadow: 'none', width: 10, height: 10 }} aria-hidden />
        <div className="k-main">
          <div className="k-title" style={{ fontSize: 16 }}>
            {project.name}
          </div>
          <div className="k-sub">
            {project.status === 'active' ? '' : `${project.status} · `}
            {progressOf(tasks).line}
            {project.deliveredAt ? ` · delivered ${timeAgo(project.deliveredAt)}` : ''}
          </div>
        </div>
        {project.status === 'active' && (
          <Button small variant="ghost" className="k-quiet" disabled={busy} onClick={pause} title="Everyone working on it stops where they are; their tasks wait, and nothing new starts until you resume">
            Pause project
          </Button>
        )}
        {project.status === 'paused' && (
          <Button small disabled={busy} onClick={() => run(() => api('POST', `/projects/${project.id}/resume`, {}), `${project.name} resumed`)}>
            Resume project
          </Button>
        )}
        {can.deleteProject(project.hostId) && (
          <Button small variant="ghost" className="k-quiet" disabled={busy} onClick={remove} title="Remove the project and its tasks from the office. Its people stay; nothing on disk is touched">
            Delete project…
          </Button>
        )}
      </div>
      <Tabs<ProjectTab>
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'about', label: 'About' },
          { id: 'plan', label: 'Plan' },
          { id: 'integration', label: 'Integration' },
          { id: 'policy', label: 'Policy' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="pw-body pj-body" data-project-tab={tab}>
        {/* What a tab is for, said once at its top. */}
        {TAB_ABOUT[tab] && (
          <div className="k-text" style={{ marginBottom: 16 }}>
            {TAB_ABOUT[tab]}
          </div>
        )}
        {tab === 'overview' && <ProjectOverview project={project} onTab={setTab} />}
        {tab === 'about' && <ProjectAbout project={project} />}
        {tab === 'integration' && <ProjectIntegration project={project} />}
        {tab === 'policy' && <ProjectPolicyTab project={project} />}
        {tab === 'plan' && <ProjectPlan project={project} />}
      </div>
    </div>
  );
}

/** arg: a project id to preselect. */
function ProjectsPanel({ arg, onClose }: PanelProps) {
  const s = useOffice();
  const { scope, own } = useScope();
  const projects = scoped(
    Object.values(s.projects).sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived') || a.name.localeCompare(b.name)),
    scope,
    own,
    (p) => whoseProject(s.hosts, s.me, p).kind === 'mine',
  );
  const [selected, setSelected] = useState(() => (arg && s.projects[arg] ? arg : (projects[0]?.id ?? NEW)));
  const project = s.projects[selected];
  // The selected project was deleted (here or by someone else): show the next one, not an empty form.
  useEffect(() => {
    if (selected !== NEW && !s.projects[selected]) setSelected(projects[0]?.id ?? NEW);
  }, [selected, s.projects]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Window
      kit
      title="Projects"
      subtitle={`${projectsLine(Object.values(s.projects))} — what is being built, how far each is, and its rules`}
      onClose={onClose}
      width={1160}
      flush
      actions={
        // (Not blue: what is done most in this window is inside a project — saving, asking for a plan, promoting.)
        <Button disabled={selected === NEW} onClick={() => setSelected(NEW)}>
          New project
        </Button>
      }
    >
      <div className="pj-frame">
        <aside className="pj-side">
          <ScopeSwitch what="projects" />
          {projects.map((p) => {
            const progress = progressOf(workTasks(s.tasks, p.id));
            return (
              <button key={p.id} type="button" className={`pj-item pw-list-btn ${selected === p.id ? 'pj-item-on' : ''} ${p.status === 'archived' ? 'k-dim' : ''}`} onClick={() => setSelected(p.id)} data-project={p.id}>
                <span className="k-dot" style={{ background: p.color, boxShadow: 'none' }} aria-hidden />
                <span className="k-main">
                  <span className="k-title k-title-sm" style={{ fontWeight: 600 }}>
                    {p.name}
                    {own && scope === 'all' && whoseProject(s.hosts, s.me, p).kind !== 'shared' && <span className="k-title-note">{whoseLabel(whoseProject(s.hosts, s.me, p))}</span>}
                  </span>
                  <span className="k-bar k-bar-thin" aria-hidden>
                    {progress.parts.map((part) => (
                      <i key={part.part} className={`k-bar-${part.part}`} style={{ width: `${part.percent}%` }} />
                    ))}
                  </span>
                  <span className="k-sub">
                    {p.status === 'active' ? '' : `${p.status} · `}
                    {progress.total ? `${progress.done} of ${progress.total} done` : 'no tasks yet'}
                  </span>
                </span>
              </button>
            );
          })}
          {projects.length === 0 && <div className="k-sub">No projects yet.</div>}
        </aside>
        <div className="pj-main">
          {project ? (
            <ProjectDetail key={project.id} project={project} />
          ) : (
            <div className="pw-body">
              <div className="k-stack">
                <div>
                  <div className="k-title" style={{ fontSize: 16 }}>
                    New project
                  </div>
                  <div className="k-text">A project is a folder your employees work in — usually a git repository — with what they are told about it and the rules they keep there.</div>
                </div>
                <ProjectCreate onCreated={setSelected} />
              </div>
            </div>
          )}
        </div>
      </div>
    </Window>
  );
}

registerPanel('projects', ProjectsPanel);
