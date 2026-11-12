import type { Employee, Host, Project, Task, TaskKind, TaskPriority } from '@orchestrator/contracts';
import { ACTIVITY_LABEL, LEAD_HIRE_LIMIT, LEAD_ROLE, ROLE_CATALOGUE, formatDuration, matchRole, redactSecrets, roleByKey, truncate } from '@orchestrator/contracts';
import type { McpToolHandler, McpToolResult } from '@orchestrator/integrations';
import { plainScreen } from './comms.ts';
import { EngineError } from './core.ts';
import type { Engine } from './engine.ts';
import type { McpContext } from './mcp-tools.ts';

/**
 * A member's team lead: one employee, in that member's own room, who is told what the member wants and sees that
 * the right one of the member's employees gets it.
 *
 * It is not a second foreman. The foreman is the office's: one for everybody, called by the office in rounds, the
 * owners' alone. A lead is a member's: called only when its member (or an owner) speaks to it, it looks only at
 * that member's team, and it answers to that member. It does nothing by itself and is never woken by a timer —
 * a lead costs tokens only when somebody talks to it.
 *
 * What it may do is these tools and nothing else (its session cannot edit files): see the team, look at one of
 * them, tell one something, put a task on a board of theirs and say who takes it, look through the folders of
 * the member's machines, and hire — onto the member's own machines only, and no more than LEAD_HIRE_LIMIT people
 * at a time. When it is not sure who should take something it asks its member (the ordinary ask_boss): its
 * questions are its own, so they reach that member.
 *
 * The team: the employees on the member's own computers and servers, and the shared employees that member looks
 * after (`Employee.keptBy`). Where the member asked for it (`leadScope: 'office'`), all the shared employees of the
 * office — what that member may direct anyway.
 */

const err = (text: string): McpToolResult => ({ text, isError: true });
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const PRIORITIES: unknown[] = ['low', 'normal', 'high', 'urgent'] satisfies TaskPriority[];
const KINDS: unknown[] = ['feature', 'bug', 'test', 'research', 'planning', 'security', 'docs', 'ops', 'refactor', 'chore'] satisfies TaskKind[];
const SCREEN_LINES = 25;
const OPEN: Task['status'][] = ['IN_PROGRESS', 'READY', 'BLOCKED', 'REVIEW', 'BACKLOG'];

/** Roles nobody is hired into by a lead: the office's foreman, and another lead. */
const NOT_HIRED = new Set(['foreman', LEAD_ROLE]);

export class Lead {
  private eng: Engine;

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  /** The member a lead works for: whose computer it sits on. Null for an employee who is no member's (and so no lead). */
  memberOf(lead: Pick<Employee, 'hostId'>): string | null {
    return this.eng.hosts.memberOfHost(lead.hostId);
  }

  /** That member's lead, if they have one. */
  leadOf(memberId: string | null | undefined, exceptId: string | null = null): Employee | undefined {
    if (!memberId) return undefined;
    return this.core.employees.find((e) => !e.archived && e.roleKey === LEAD_ROLE && e.id !== exceptId && this.eng.hosts.memberOfHost(e.hostId) === memberId);
  }

  /** Does this lead look after the office's shared employees too? */
  private wide(lead: Employee): boolean {
    return lead.leadScope === 'office';
  }

  /** Is something on this machine the lead's to see and direct: its member's own, or — if asked for — the office's shared. */
  private within(lead: Employee, hostId: string | null | undefined): boolean {
    const member = this.memberOf(lead);
    if (!member || !hostId) return false;
    const its = this.eng.hosts.memberOfHost(hostId);
    return its === member || (!its && this.wide(lead));
  }

  /** The people a lead directs: everyone within its reach who does work — not itself, not the foreman, not another lead. */
  team(lead: Employee): Employee[] {
    const member = this.memberOf(lead);
    const rank = (e: Employee) => (this.memberOf(e) ? 0 : e.keptBy?.id === member ? 1 : 2);
    return this.core.employees
      .filter((e) => !e.archived && e.id !== lead.id && !NOT_HIRED.has(e.roleKey) && !e.selfDriven && (this.within(lead, e.hostId) || this.kept(lead, e)))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  /** A shared employee the lead's member looks after: theirs to direct, on the shared projects that employee works on. */
  private kept(lead: Employee, e: Employee): boolean {
    const member = this.memberOf(lead);
    return !!member && e.keptBy?.id === member && !this.eng.hosts.memberOfHost(e.hostId);
  }

  /** The projects a lead may put work on. */
  private projects(lead: Employee): Project[] {
    // …and the shared projects of the shared employees its member looks after.
    const theirs = new Set(this.core.employees.filter((e) => !e.archived && this.kept(lead, e)).flatMap((e) => [e.projectId, ...(e.alsoProjectIds ?? [])]));
    return this.core.projects.filter((p) => p.status !== 'archived' && (this.within(lead, p.hostId) || theirs.has(p.id))).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The member's own machines: where a lead may hire and look for folders. Never a shared one. */
  private machines(lead: Employee): Host[] {
    const member = this.memberOf(lead);
    return member ? this.eng.hosts.ofMember(member).filter((h) => h.status !== 'revoked') : [];
  }

  /** Whom this lead hired and who is still here: what the limit counts. */
  hired(lead: Employee): Employee[] {
    return this.core.employees.filter((e) => !e.archived && e.hiredBy === lead.id);
  }

  private find(lead: Employee, ref: string): Employee | undefined {
    const e = this.core.employeeByName(ref) ?? this.core.employees.get(ref.trim());
    return e && this.team(lead).some((x) => x.id === e.id) ? e : undefined;
  }

  private findProject(lead: Employee, ref: string): Project | undefined {
    const n = ref.trim().toLowerCase();
    const mine = this.projects(lead);
    const starts = n ? mine.filter((p) => p.name.toLowerCase().startsWith(n)) : [];
    const has = n ? mine.filter((p) => p.name.toLowerCase().includes(n)) : [];
    return mine.find((p) => p.id === ref.trim()) ?? mine.find((p) => p.name.toLowerCase() === n) ?? (starts.length === 1 ? starts[0] : has.length === 1 ? has[0] : undefined);
  }

  private whose(lead: Employee, hostId: string | null | undefined): string {
    const host = this.core.hosts.get(hostId ?? '');
    return !host ? 'no machine' : this.eng.hosts.memberOfHost(host.id) ? host.name : `${host.name} (shared office)`;
  }

  /** Where somebody is, and — for a shared employee the member looks after — that they are. */
  private place(lead: Employee, e: Employee): string {
    return this.kept(lead, e) ? `${this.core.hosts.get(e.hostId ?? '')?.name ?? 'no machine'} (shared office, looked after by your boss)` : this.whose(lead, e.hostId);
  }

  /** Who the lead answers to, by name, for its own words. */
  private bossName(lead: Employee): string {
    return this.core.hosts.get(lead.hostId ?? '')?.memberName ?? 'your boss';
  }

  /** The team at a glance. Short on purpose: this is read on every request. */
  private overview(lead: Employee): string {
    const core = this.core;
    const now = Date.now();
    const team = this.team(lead);
    const left = LEAD_HIRE_LIMIT - this.hired(lead).length;
    const lines: string[] = [`Your team — ${team.length} ${team.length === 1 ? 'person' : 'people'}${this.wide(lead) ? ' (your boss\'s own employees first, then the office\'s shared ones)' : ''}.`];
    if (!team.length) lines.push('- nobody yet. Hire someone (team_hire) once you know which folder the work is in.');
    for (const e of team) {
      const s = core.sessionOf(e.id);
      const live = !!s && (s.status === 'running' || s.status === 'starting');
      const task = this.eng.tasks.currentTask(e.id);
      const queued = core.tasks.filter((t) => t.assigneeId === e.id && (t.status === 'READY' || t.status === 'BLOCKED' || t.status === 'REVIEW')).length;
      const done = core.tasks
        .filter((t) => t.assigneeId === e.id && t.status === 'DONE')
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
        .slice(0, 3)
        .map((t) => `"${truncate(t.title, 50)}"`);
      const projects = [e.projectId, ...(e.alsoProjectIds ?? [])].map((id) => core.projects.get(id ?? '')?.name).filter(Boolean);
      const away = !!this.memberOf(e) && !core.agents.isOnline(e.hostId ?? '');
      const state = away ? 'their machine is not in the office now' : !s ? 'no session yet (starts when given work)' : !live ? (this.eng.sessions.asleep(e.id) ? 'asleep (wakes when given work)' : `not running (${s.status})`) : `${ACTIVITY_LABEL[s.activity] ?? s.activity} for ${formatDuration(now - Date.parse(s.activitySince))}`;
      lines.push(
        `- ${e.name} — ${e.title} · ${this.place(lead, e)} · project: ${projects.join(', ') || 'none'}${e.workingDir ? ` · folder: ${e.workingDir}` : ''} · ${state} · ${task ? `on ${task.key} "${truncate(task.title, 60)}"` : 'free'}${queued ? ` · ${queued} more waiting` : ''}${done.length ? ` · lately did: ${done.join(', ')}` : ''}${e.specialization ? ` · ${truncate(e.specialization, 60)}` : ''}`,
      );
    }
    const projects = this.projects(lead);
    lines.push('', 'Projects you can put work on:');
    if (!projects.length) lines.push('- none yet (hiring someone into a folder makes that folder a project)');
    for (const p of projects) {
      const tasks = core.tasks.filter((t) => t.projectId === p.id && t.kind !== 'review' && OPEN.includes(t.status));
      lines.push(`- ${p.name} · ${this.whose(lead, p.hostId)}${p.repoPath ? ` · ${p.repoPath}` : ''}${p.description ? ` · ${truncate(oneLine(p.description), 80)}` : ''} · ${tasks.length} open task${tasks.length === 1 ? '' : 's'}`);
    }
    lines.push('', `Machines you can hire onto: ${this.machines(lead).map((h) => `${h.name}${core.agents.isOnline(h.id) ? '' : ' (not here now)'}`).join(', ') || 'none'}. You may hire ${Math.max(0, left)} more (${LEAD_HIRE_LIMIT} at most at a time).`);
    return lines.join('\n');
  }

  private look(target: Employee): string {
    const core = this.core;
    const now = Date.now();
    const s = core.sessionOf(target.id);
    const live = !!s && (s.status === 'running' || s.status === 'starting');
    const task = this.eng.tasks.currentTask(target.id);
    const lines: string[] = [`${target.name} — ${target.title} · ${core.projects.get(target.projectId ?? '')?.name ?? 'no project'}`];
    lines.push(!s ? 'Session: none yet.' : !live ? `Session: not running (${s.status}).` : `Session: ${ACTIVITY_LABEL[s.activity] ?? s.activity} for ${formatDuration(now - Date.parse(s.activitySince))}${s.activityDetail ? ` — ${truncate(s.activityDetail, 100)}` : ''}.`);
    if (task) lines.push(`Current task: ${task.key} [${task.status}] ${task.title}`, truncate(task.description.trim() || '(no description)', 600));
    const theirs = core.tasks.filter((t) => t.assigneeId === target.id && t.id !== task?.id && (t.status === 'READY' || t.status === 'BLOCKED' || t.status === 'REVIEW'));
    if (theirs.length) lines.push(`Also theirs: ${theirs.map((t) => `${t.key} [${t.status}] ${truncate(t.title, 50)}`).join('; ')}`);
    const q = core.questions.find((x) => x.employeeId === target.id && x.status === 'open' && x.channel !== 'system');
    if (q) lines.push(`Open ${q.kind === 'question' ? 'question' : 'request for the boss'}: "${truncate(oneLine(q.text), 300)}"`);
    // What they were told and what they answered lately: how one knows what somebody is in the middle of.
    const events = core.store.queryEvents({ employeeId: target.id, limit: 8, excludeTypes: ['session.activity', 'terminal.output'] });
    if (events.length) lines.push('Lately:', ...events.map((e) => `- ${e.ts.slice(11, 16)} ${truncate(oneLine(e.summary), 140)}`));
    const screen = live ? core.gateway.screens.get(s!.id) : undefined;
    if (screen) {
      const text = plainScreen(screen.lines).map((l) => l.trimEnd());
      while (text.length && !text[text.length - 1]) text.pop();
      const tail = text.slice(-SCREEN_LINES).map((l) => redactSecrets(truncate(l, 160)));
      if (tail.length) lines.push(`Their terminal now (last ${tail.length} lines):`, '```', ...tail, '```');
    }
    return lines.join('\n');
  }

  /** The lead's MCP tools. Every one of them refuses a caller who is not a lead, and reaches no further than its member's team. */
  handlers(): Record<string, McpToolHandler<McpContext>> {
    const core = this.core;
    const actor = (e: Employee) => `lead:${e.name}`;
    const only =
      (tool: string, fn: McpToolHandler<McpContext>): McpToolHandler<McpContext> =>
      async (args, ctx) => {
        if (ctx.employee.roleKey !== LEAD_ROLE || !this.memberOf(ctx.employee)) {
          core.audit(`employee:${ctx.employee.name}`, 'lead.tool_refused', tool, { role: ctx.employee.roleKey });
          return err(`Only a team lead can use ${tool}. You are ${ctx.employee.title}; use ask_boss, send_message or request_collaboration instead.`);
        }
        try {
          return await fn(args, ctx);
        } catch (e) {
          // What the office refuses (work that would cross between computers, a name that is taken, …) is an answer, said in its words.
          if (e instanceof EngineError) return err(e.message);
          throw e;
        }
      };
    const nobody = (ref: unknown) => err(`Nobody on your team matches "${ref}". Use team_overview to see who is on it.`);

    const tools: Record<string, McpToolHandler<McpContext>> = {
      team_overview: async (_a, { employee }) => this.overview(employee),

      team_look: async (a, { employee }) => {
        const target = this.find(employee, String(a.employee ?? ''));
        return target ? this.look(target) : nobody(a.employee);
      },

      team_tell: async (a, { employee }) => {
        const to = this.find(employee, String(a.employee ?? ''));
        if (!to) return nobody(a.employee);
        const message = String(a.message ?? '').trim();
        if (!message) return err('Say what they should do: "message" is empty.');
        if (this.memberOf(to) && !core.agents.isOnline(to.hostId ?? '')) return err(`${to.name}'s machine is not in the office right now; nothing can be delivered there. Tell ${this.bossName(employee)}.`);
        this.eng.comms.sendMessage({ from: { kind: 'employee', id: employee.id, name: `${employee.name} (${this.bossName(employee)}'s lead)` }, toEmployeeId: to.id, body: truncate(message, 4000), taskId: this.eng.tasks.currentTask(to.id)?.id ?? null });
        core.audit(actor(employee), 'lead.told', to.id, {});
        // Somebody who has never been started is started for it (someone asleep is woken by the message itself).
        const running = !!core.runningSessionOf(to.id);
        if (!running && !this.eng.sessions.asleep(to.id)) void this.eng.sessions.start(to.id, { resume: true }).catch(() => undefined);
        return `Told ${to.name}. It reaches their session ${running ? 'when they can read it' : 'as soon as their session is up (they are being started for it)'}.`;
      },

      team_task: async (a, { employee }) => {
        const project = this.findProject(employee, String(a.project ?? ''));
        if (!project) return err(`No project of yours matches "${a.project}". Yours: ${this.projects(employee).map((p) => p.name).join(', ') || 'none'}. If you are not sure which is meant, ask ${this.bossName(employee)} (ask_boss).`);
        if (project.status !== 'active') return err(`${project.name} is ${project.status}; ${this.bossName(employee)} decides when work on it continues.`);
        let assigneeId: string | null = null;
        if (a.assignee) {
          const to = this.find(employee, String(a.assignee));
          if (!to) return nobody(a.assignee);
          assigneeId = to.id;
        }
        const title = truncate(oneLine(String(a.title ?? '')), 160);
        if (!title) return err('A task needs a title.');
        const task = this.eng.tasks.createTask(
          { projectId: project.id, title, description: String(a.description ?? ''), acceptance: a.acceptance ? String(a.acceptance) : '', assigneeId, priority: PRIORITIES.includes(a.priority) ? (a.priority as TaskPriority) : 'normal', kind: KINDS.includes(a.kind) ? (a.kind as TaskKind) : 'feature' },
          actor(employee),
        );
        return `Created ${task.key} "${task.title}" in ${project.name}${assigneeId ? `, assigned to ${core.employees.get(assigneeId)?.name}` : ', unassigned'} (${task.status}).`;
      },

      team_assign: async (a, { employee }) => {
        const task = this.eng.tasks.taskByKey(String(a.task ?? ''));
        if (!task || !this.projects(employee).some((p) => p.id === task.projectId)) return err(`No task "${a.task}" on a board of yours.`);
        const to = this.find(employee, String(a.employee ?? ''));
        if (!to) return nobody(a.employee);
        if (task.assigneeId === to.id) return `${task.key} is already ${to.name}'s.`;
        this.eng.tasks.updateTask(task.id, { assigneeId: to.id }, actor(employee));
        return `${task.key} "${truncate(task.title, 80)}" is now ${to.name}'s.`;
      },

      team_folders: async (a, { employee }) => {
        const machines = this.machines(employee);
        const ref = String(a.machine ?? '').trim().toLowerCase();
        const host = ref ? machines.find((h) => h.name.toLowerCase() === ref || h.id === ref) ?? machines.find((h) => h.name.toLowerCase().includes(ref)) : (machines.find((h) => h.id === employee.hostId) ?? machines[0]);
        if (!host) return err(`No machine of ${this.bossName(employee)}'s matches "${a.machine ?? ''}". Theirs: ${machines.map((h) => h.name).join(', ') || 'none'}.`);
        if (!core.agents.isOnline(host.id)) return err(`${host.name} is not in the office right now.`);
        const listing = (await core.agents.rpc(host.id, { method: 'fs.browse', params: { path: a.path ? String(a.path) : null } }).catch((e) => ({ error: (e as Error).message }))) as { error?: string; path?: string; folders?: Array<{ name: string; path: string; repo: boolean; claude: boolean }>; roots?: string[] };
        if (listing.error || !listing.path) return err(`${host.name} would not show that folder: ${listing.error ?? 'no answer'}. Folders it lets the office into: ${(listing.roots ?? []).join(', ') || 'ask your boss'}.`);
        const folders = listing.folders ?? [];
        return [`${host.name}: ${listing.path}`, ...folders.slice(0, 80).map((f) => `- ${f.name}${f.repo ? ' [git repository]' : ''}${f.claude ? ' [has CLAUDE.md]' : ''}`), folders.length > 80 ? `… and ${folders.length - 80} more` : '', folders.length ? '' : '(no folders inside)'].filter(Boolean).join('\n');
      },

      team_hire: async (a, { employee }) => {
        const boss = this.bossName(employee);
        const have = this.hired(employee);
        if (have.length >= LEAD_HIRE_LIMIT) return err(`You have hired ${have.length} people who are still here (${have.map((e) => e.name).join(', ')}), and ${LEAD_HIRE_LIMIT} is the most a lead may have. Use the people you have, or ask ${boss} to let someone go (ask_boss).`);
        const role = roleByKey(String(a.role ?? '')) ?? matchRole(String(a.role ?? ''));
        if (!role || NOT_HIRED.has(role.key)) return err(`"${a.role}" is not a role you can hire. Roles: ${ROLE_CATALOGUE.filter((r) => !NOT_HIRED.has(r.key)).map((r) => r.key).join(', ')}.`);
        const machines = this.machines(employee);
        const ref = String(a.machine ?? '').trim().toLowerCase();
        const host = ref ? machines.find((h) => h.name.toLowerCase() === ref || h.id === ref) ?? machines.find((h) => h.name.toLowerCase().includes(ref)) : (machines.find((h) => h.id === employee.hostId) ?? machines[0]);
        if (!host) return err(`You hire onto ${boss}'s own machines only: ${machines.map((h) => h.name).join(', ') || 'none are here'}.`);
        const project = a.project ? this.findProject(employee, String(a.project)) : undefined;
        if (a.project && !project) return err(`No project of yours matches "${a.project}".`);
        if (project && project.hostId !== host.id) return err(`${project.name} is not on ${host.name}. Someone works on the projects of the machine they are on.`);
        const folder = String(a.folder ?? '').trim();
        if (!project && !folder) return err(`Say where they work: "project" (one of yours) or "folder" (a folder on ${host.name}; team_folders shows what is there). If you do not know, ask ${boss} (ask_boss).`);
        const name = oneLine(String(a.name ?? '')).slice(0, 40);
        if (!name) return err('Give them a name.');
        const why = truncate(oneLine(String(a.why ?? '')), 200);
        if (!why) return err('Say in "why" what you need them for: it is what your boss reads.');
        const hiredOne = await this.eng.hire(
          // (Never Unrestricted, never a model of the lead's choosing above what the role starts with: both are the member's to give.)
          { name, roleKey: role.key, hostId: host.id, ...(project ? { projectId: project.id } : { workingDir: folder }), ...(a.instructions ? { instructions: truncate(String(a.instructions), 2000) } : {}) },
          actor(employee),
          { hiredBy: employee.id },
        );
        const left = LEAD_HIRE_LIMIT - this.hired(employee).length;
        this.eng.comms.notify({ kind: 'info', severity: 'info', title: `${employee.name} hired ${hiredOne.name} (${hiredOne.title})`, body: `${why}\n\nOn ${host.name}, ${project ? `project ${project.name}` : `folder ${hiredOne.workingDir ?? folder}`}. ${employee.name} may hire ${left} more.`, employeeId: employee.id, sessionId: null, taskId: null, projectId: hiredOne.projectId, questionId: null, hostId: host.id });
        core.audit(actor(employee), 'lead.hired', hiredOne.id, { name: hiredOne.name, role: role.key, host: host.id, why });
        return `Hired ${hiredOne.name} as ${hiredOne.title} on ${host.name}, project ${core.projects.get(hiredOne.projectId ?? '')?.name ?? 'none'}. ${boss} has been told. They start when you give them work (team_task or team_tell). You may hire ${left} more.`;
      },
    };
    return Object.fromEntries(Object.entries(tools).map(([name, fn]) => [name, only(name, fn)]));
  }
}
