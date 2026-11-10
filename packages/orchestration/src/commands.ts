import type { CommandPlan, CommandResult, Employee, Operation, Project, Task } from '@orchestrator/contracts';
import { ACTIVITY_LABEL, matchRole, newId, nowIso, truncate } from '@orchestrator/contracts';
import { EngineError } from './core.ts';
import type { Engine } from './engine.ts';
import { reportPrompt } from './prompts.ts';

type Planned = { operation: Operation; description: string };

const IMPLEMENT_VERBS = /\b(fix|implement|add|build|create|improve|refactor|update|write|change|remove|migrate|upgrade|optimi[sz]e|make|port|rename)\b/i;

export function inferKind(text: string): Task['kind'] {
  const t = text.toLowerCase();
  if (/\b(fix|bug|broken|crash(es|ing)?|regression|error)\b/.test(t)) return 'bug';
  if (/\bsecurity\b|\bvulnerab|\bthreat model|\bpen ?test/.test(t)) return 'security';
  if (/\b(refactor(ing)?|clean ?up|tech(nical)? debt|simplify|dead code|de-?duplicate|tidy up)\b/.test(t)) return 'refactor';
  if (/^\s*(code[- ]?)?review\b|\breview (the|all|every|this|that)\b/.test(t) && !IMPLEMENT_VERBS.test(t)) return 'review';
  if (/\b(test|tests|testing|qa|verify)\b/.test(t)) return 'test';
  if (/\b(document|documentation|docs|readme|changelog)\b/.test(t)) return 'docs';
  if (/\b(deploy|pipeline|ci|cd|docker|kubernetes|infra(structure)?)\b/.test(t)) return 'ops';
  if (/\b(research|investigate|analy[sz]e|inspect|audit|explore|evaluate|compare|find out)\b/.test(t) && !IMPLEMENT_VERBS.test(t)) return 'research';
  if (/^\s*plan\b|\bbreak (it|this|the work) down\b/.test(t)) return 'planning';
  return 'feature';
}

function inferPriority(text: string): Task['priority'] {
  const t = text.toLowerCase();
  if (/\b(urgent|asap|immediately|right now|critical|p0)\b/.test(t)) return 'urgent';
  if (/\b(important|high priority|soon|p1)\b/.test(t)) return 'high';
  if (/\b(low priority|whenever|eventually|nice to have)\b/.test(t)) return 'low';
  return 'normal';
}

function capitalise(s: string): string {
  const t = s.trim().replace(/[.!]+$/, '');
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/**
 * Turns the owner's natural-language instructions into explicit, validated
 * operations. The plan is shown to the owner before anything runs, and an
 * instruction that cannot be resolved produces problems, not guesses.
 */
export class CommandCenter {
  private eng: Engine;

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  private employees(): Employee[] {
    return this.core.employees.filter((e) => !e.archived);
  }

  private employeeNamed(word: string): Employee | undefined {
    const w = word.replace(/[^\p{L}\p{N}_-]/gu, '').toLowerCase();
    if (!w) return undefined;
    return this.employees().find((e) => e.name.toLowerCase() === w || e.name.toLowerCase().split(/\s+/)[0] === w);
  }

  private employeesMentioned(text: string): Employee[] {
    const words = new Set(text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u));
    return this.employees().filter((e) => words.has(e.name.toLowerCase().split(/\s+/)[0]!));
  }

  private activeProjects(): Project[] {
    return this.core.projects.filter((p) => p.status !== 'archived');
  }

  private projectNamed(ref: string): Project | undefined {
    const r = ref.trim().toLowerCase().replace(/^(the )?project\s+/, '').replace(/\s+project$/, '').replace(/[."']/g, '');
    if (!r) return undefined;
    const all = this.activeProjects();
    return all.find((p) => p.name.toLowerCase() === r) ?? all.find((p) => p.name.toLowerCase() === `project ${r}`) ?? all.find((p) => p.name.toLowerCase().startsWith(r)) ?? all.find((p) => p.name.toLowerCase().includes(r));
  }

  private projectMentioned(text: string): Project | undefined {
    const t = text.toLowerCase();
    return this.activeProjects()
      .sort((a, b) => b.name.length - a.name.length)
      .find((p) => t.includes(p.name.toLowerCase()));
  }

  private defaultProject(employee?: Employee): Project | undefined {
    if (employee?.projectId) return this.core.projects.get(employee.projectId);
    const active = this.core.projects.filter((p) => p.status === 'active');
    return active.length === 1 ? active[0] : undefined;
  }

  /** "test everything Alex changed" → concrete references to Alex's real work. */
  private workContext(text: string, exclude: Employee): string {
    const others = this.employeesMentioned(text).filter((e) => e.id !== exclude.id);
    const lines: string[] = [];
    for (const o of others) {
      const tasks = this.core.tasks
        .filter((t) => t.assigneeId === o.id && (t.status === 'DONE' || t.status === 'REVIEW' || t.status === 'IN_PROGRESS') && t.kind !== 'review')
        .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
        .slice(0, 6);
      if (!tasks.length) continue;
      lines.push(`${o.name}'s recent work:`);
      for (const t of tasks) lines.push(`- ${t.key} "${t.title}" [${t.status}]${t.branch ? ` on branch ${t.branch}` : ''}${t.evidence.filesChanged.length ? ` — files: ${t.evidence.filesChanged.slice(0, 8).join(', ')}` : ''}`);
    }
    return lines.join('\n');
  }

  private taskFor(employee: Employee, what: string, input: string, problems: string[]): Planned | null {
    const project = this.projectMentioned(input) ?? this.defaultProject(employee);
    if (!project) {
      problems.push(`I don't know which project "${truncate(what, 60)}" belongs to. ${employee.name} has no project; name one (e.g. "… in <project>") or assign ${employee.name} to a project.`);
      return null;
    }
    const kind = inferKind(what);
    const ctx = this.workContext(input, employee);
    return {
      operation: { op: 'task.create', projectId: project.id, title: truncate(capitalise(what), 90), description: [`Instruction from the boss: ${input}`, ctx].filter(Boolean).join('\n\n'), assigneeId: employee.id, roleHint: null, kind, priority: inferPriority(input), start: true },
      description: `Create a ${kind} task in ${project.name} for ${employee.name}: "${truncate(capitalise(what), 80)}" and start it when ${employee.name} is free`,
    };
  }

  /** Rule-based interpretation. Deterministic, offline, and free. */
  plan(raw: string): CommandPlan {
    const input = raw.trim().replace(/\s+/g, ' ');
    const text = input.replace(/[.!?]+$/, '');
    const lower = text.toLowerCase();
    const ops: Planned[] = [];
    const problems: string[] = [];
    const done = (): CommandPlan => ({ input, interpretedBy: 'rules', operations: problems.length ? [] : ops, problems });
    if (!text) return { input, interpretedBy: 'rules', operations: [], problems: ['Type an instruction.'] };
    let m: RegExpExecArray | null;

    // ── queries ──
    if (/(needs?|need|waiting for|wants?) (my|me|your) ?(attention|input|decision|approval)?/.test(lower) && /(who|everyone|anyone|show|what|list)/.test(lower)) {
      ops.push({ operation: { op: 'query.attention' }, description: 'List everyone and everything waiting on you' });
      return done();
    }
    if (/\b(summari[sz]e|summary|recap|catch me up|what (has )?happened|what did i miss)\b/.test(lower) && !/\b(ask|have|get|tell)\s+\w+\s+to\b/.test(lower)) {
      ops.push({ operation: { op: 'query.summary', since: this.core.settings.lastSeenAt }, description: 'Summarise recorded events since you were last here' });
      return done();
    }
    if ((m = /\b(?:find|show|who(?: is|'s)?|list|any)\b.*?\b(?:available|free|idle)\b\s*(.*)$/.exec(lower))) {
      const role = matchRole(m[1] ?? '') ?? matchRole(lower);
      ops.push({ operation: { op: 'query.available', role: role?.key ?? null }, description: `Find available ${role ? role.title + 's' : 'employees'}` });
      return done();
    }

    // ── projects ──
    if ((m = /^pause (?:work on |all work on )?(.+?),? and (?:move|switch|put|reassign) (?:the |whole |entire )?(?:team|everyone|them) (?:to|on|onto) (.+)$/i.exec(text))) {
      const from = this.projectNamed(m[1]!);
      const to = this.projectNamed(m[2]!);
      if (!from) problems.push(`No project matches "${m[1]}".`);
      if (!to) problems.push(`No project matches "${m[2]}".`);
      if (from && to) {
        ops.push({ operation: { op: 'project.pause', projectId: from.id }, description: `Pause ${from.name}: interrupt its in-progress work and stop scheduling its tasks` });
        ops.push({ operation: { op: 'project.move_team', fromProjectId: from.id, toProjectId: to.id }, description: `Move ${from.name}'s team to ${to.name}` });
      }
      return done();
    }
    if ((m = /^(pause|stop|halt|interrupt|resume|unpause|continue) (?:work on |project )?(.+)$/i.exec(text))) {
      const verb = m[1]!.toLowerCase();
      const resume = verb === 'resume' || verb === 'unpause' || verb === 'continue';
      const target = m[2]!.trim();
      const emp = /\s/.test(target) ? undefined : this.employeeNamed(target);
      if (emp) {
        ops.push(resume ? { operation: { op: 'employee.resume', employeeId: emp.id }, description: `Resume ${emp.name}` } : { operation: { op: 'employee.pause', employeeId: emp.id }, description: `Interrupt ${emp.name} (sends Escape to their terminal) and hold them until resumed` });
        return done();
      }
      const proj = this.projectNamed(target);
      if (proj) {
        ops.push(resume ? { operation: { op: 'project.resume', projectId: proj.id }, description: `Resume project ${proj.name}` } : { operation: { op: 'project.pause', projectId: proj.id }, description: `Pause ${proj.name}: interrupt its in-progress work and stop scheduling its tasks` });
        return done();
      }
      problems.push(`Nothing called "${target}" to ${verb}: no employee or project matches.`);
      return done();
    }

    // ── meetings ──
    const teamReview = /^(?:ask|have|get|tell) (?:the )?(?:whole |entire )?(?:team|everyone|everybody) to (review|discuss|evaluate|assess|debate|plan) (.+)$/i.exec(text);
    const meetingVerb = /^(?:organi[sz]e|schedule|hold|start|set up|run|call|convene) (?:an? |the )?(.*?\b(?:meeting|review|discussion|retro(?:spective)?|planning session|sync|brainstorm)\b.*)$/i.exec(text);
    if (teamReview || meetingVerb) {
      const topic = capitalise(teamReview ? `${teamReview[1]} ${teamReview[2]}` : meetingVerb![1]!);
      const project = this.projectMentioned(text) ?? this.defaultProject();
      const named = this.employeesMentioned(text);
      const pool = named.length >= 2 ? named : this.employees().filter((e) => !!this.core.runningSessionOf(e.id) && (!project || e.projectId === project.id || e.projectId === null));
      const participants = pool.length >= 2 ? pool : this.employees().filter((e) => !!this.core.runningSessionOf(e.id));
      if (participants.length < 2) problems.push('A meeting needs at least two employees with running sessions.');
      else {
        const facilitator = participants.find((e) => e.roleKey === 'architect') ?? participants.find((e) => e.roleKey === 'pm') ?? participants[0]!;
        ops.push({
          operation: { op: 'meeting.create', projectId: project?.id ?? null, topic, participantIds: participants.map((e) => e.id), facilitatorId: facilitator.id },
          description: `Hold a meeting "${topic}" with ${participants.map((e) => e.name).join(', ')} (facilitator: ${facilitator.name}). Each one's real session contributes; the result is a decision document and tasks.`,
        });
      }
      return done();
    }

    // ── planning a whole objective ──
    const roleMentions = (lower.match(/\b(back[- ]?end|front[- ]?end|qa|security|devops|database|architect)\b/g) ?? []).length;
    if ((/^(build|create|implement|develop|deliver|make|ship)\b/.test(lower) && (/\b(split|divide|break|distribute)\b.*\bwork\b/.test(lower) || roleMentions >= 2)) || /^plan (out )?\b/.test(lower)) {
      const project = this.projectMentioned(text) ?? this.defaultProject();
      const planner = this.employees().find((e) => e.roleKey === 'architect' && (!project || !e.projectId || e.projectId === project.id)) ?? this.employees().find((e) => e.roleKey === 'pm') ?? this.employees().find((e) => e.roleKey === 'architect');
      if (!project) problems.push('Which project is this for? Create or name a project first.');
      if (!planner) problems.push('Planning needs a Software Architect or Project Manager on the team to break the work down. Hire one first.');
      if (project && planner) {
        ops.push({ operation: { op: 'project.plan', projectId: project.id, objective: input, plannerId: planner.id }, description: `Have ${planner.name} (${planner.title}) inspect ${project.name} and propose the task breakdown; ${project.policy.autoAssign ? 'tasks are then assigned to matching roles automatically' : 'tasks then wait for your release'}` });
      }
      return done();
    }

    // ── reports ──
    if ((m = /^(?:get|ask|request|have)\b.*?\b(?:status|report|update|summary)\b.*?\b(?:from|of|by)\s+(\S+)/i.exec(text)) || (m = /^(?:ask|have|get|tell)\s+(\S+)\s+(?:for|to give|to send|to write)\s+(?:me\s+)?(?:an?\s+)?(?:status|report|update|summary)/i.exec(text))) {
      const emp = this.employeeNamed(m[1]!);
      if (emp) {
        ops.push({ operation: { op: 'employee.report', employeeId: emp.id }, description: `Ask ${emp.name}'s session for a status report` });
        return done();
      }
    }

    // ── messages ──
    if ((m = /^(?:tell|message|msg|notify|remind)\s+(\S+?)[,:]?\s+(?:that\s+|:\s*)(.+)$/i.exec(text)) || (m = /^(?:message|msg)\s+(\S+?)[,:]?\s+(.+)$/i.exec(text))) {
      const emp = this.employeeNamed(m[1]!);
      if (emp) {
        ops.push({ operation: { op: 'employee.message', employeeId: emp.id, body: m[2]!.trim() }, description: `Send ${emp.name} the message: "${truncate(m[2]!.trim(), 80)}"` });
        return done();
      }
    }

    // ── task assignment ──
    if ((m = /^assign\s+(t-\d+)\s+to\s+(\S+)$/i.exec(text))) {
      const task = this.eng.tasks.taskByKey(m[1]!);
      const emp = this.employeeNamed(m[2]!);
      if (!task) problems.push(`No task ${m[1]!.toUpperCase()}.`);
      if (!emp) problems.push(`No employee named "${m[2]}".`);
      if (task && emp) ops.push({ operation: { op: 'task.assign', taskId: task.id, assigneeId: emp.id }, description: `Assign ${task.key} "${truncate(task.title, 60)}" to ${emp.name}` });
      return done();
    }
    if ((m = /^(?:assign|ask|have|get|tell|let)\s+(\S+?),?\s+(?:to|should|must|please)\s+(.+)$/i.exec(text)) || (m = /^assign\s+(.+?)\s+to\s+(\S+)$/i.exec(text))) {
      const firstIsEmp = this.employeeNamed(m[1]!);
      const emp = firstIsEmp ?? this.employeeNamed(m[2]!);
      const what = firstIsEmp ? m[2]! : m[1]!;
      if (!emp) {
        problems.push(`No employee named "${firstIsEmp ? m[1] : m[2]}". Team: ${this.employees().map((e) => e.name).join(', ') || '(nobody hired yet)'}.`);
        return done();
      }
      const planned = this.taskFor(emp, what, input, problems);
      if (planned) ops.push(planned);
      return done();
    }
    // "Have Sarah inspect the frontend…" — causative without "to".
    if ((m = /^(?:have|let|make)\s+(\S+?),?\s+(.+)$/i.exec(text))) {
      const emp = this.employeeNamed(m[1]!);
      if (emp) {
        const planned = this.taskFor(emp, m[2]!, input, problems);
        if (planned) ops.push(planned);
        return done();
      }
    }
    if ((m = /^(\S+?)[,:]\s+(.+)$/.exec(text))) {
      const emp = this.employeeNamed(m[1]!);
      if (emp) {
        const planned = this.taskFor(emp, m[2]!, input, problems);
        if (planned) ops.push(planned);
        return done();
      }
    }

    // ── navigation ──
    if ((m = /^(?:go to|show(?: me)?|find|where(?: is|'s)|focus(?: on)?|take me to|visit)\s+(\S+)$/i.exec(text))) {
      const emp = this.employeeNamed(m[1]!);
      if (emp) {
        ops.push({ operation: { op: 'ui.focus', employeeId: emp.id }, description: `Go to ${emp.name}'s desk` });
        return done();
      }
    }

    problems.push(
      'I could not turn that into an operation. Examples: "Assign Alex to fix the authentication bug", "Have Sarah improve mobile responsiveness", "Get Mike to test everything Alex changed", "Ask the whole team to review the architecture", "Find an available backend engineer", "Pause work on Project A and move the team to Project B", "Show me everyone who needs my attention", "Summarize what happened while I was away".',
    );
    return done();
  }

  /**
   * When the rules cannot interpret an instruction and the owner enabled it, a
   * headless Claude run proposes operations. Its output goes through the same
   * validation as rule output and is never executed without confirmation.
   */
  async planWithFallback(input: string): Promise<CommandPlan> {
    const plan = this.plan(input);
    if (plan.operations.length || !this.core.settings.nlFallback) return plan;
    const host = this.core.hosts.find((h) => h.status === 'online' && this.core.agents.isOnline(h.id));
    if (!host) return plan;
    const cwd = this.core.projects.find((p) => p.hostId === host.id && !!p.repoPath)?.repoPath;
    if (!cwd) return plan;
    const team = this.employees().map((e) => `${e.name} (${e.title}; project: ${this.core.projects.get(e.projectId)?.name ?? 'none'})`).join('; ');
    const projects = this.activeProjects().map((p) => p.name).join('; ');
    const schema = {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['task', 'message', 'pause', 'resume', 'report', 'meeting', 'plan', 'attention', 'available', 'summary'] },
              employee: { type: 'string' },
              project: { type: 'string' },
              text: { type: 'string' },
              participants: { type: 'array', items: { type: 'string' } },
              role: { type: 'string' },
            },
            required: ['op'],
          },
        },
      },
      required: ['operations'],
    };
    const prompt = `Translate the instruction of a software company's owner into operations. Team: ${team || 'nobody'}. Projects: ${projects || 'none'}.\nOperations: task (employee, text=what to do, project?), message (employee, text), pause/resume (employee or project), report (employee), meeting (text=topic, participants?), plan (project, text=objective), attention, available (role?), summary.\nUse only names that exist. If the instruction cannot be expressed, return an empty list.\nInstruction: ${input}`;
    try {
      const res = await this.core.agents.rpc(host.id, { method: 'claude.headless', params: { cwd, prompt, jsonSchema: schema, timeoutMs: 60000 } }, 70000);
      const structured = res?.structured_output ?? (typeof res?.result === 'string' ? JSON.parse(res.result) : null);
      const translated: string[] = [];
      for (const o of structured?.operations ?? []) {
        // Re-express each proposed operation as a sentence the rule parser validates.
        if (o.op === 'task' && o.employee && o.text) translated.push(`have ${o.employee} to ${o.text}${o.project ? ` in ${o.project}` : ''}`);
        else if (o.op === 'message' && o.employee && o.text) translated.push(`message ${o.employee}: ${o.text}`);
        else if ((o.op === 'pause' || o.op === 'resume') && (o.employee || o.project)) translated.push(`${o.op} ${o.employee ?? o.project}`);
        else if (o.op === 'report' && o.employee) translated.push(`get a status report from ${o.employee}`);
        else if (o.op === 'meeting' && o.text) translated.push(`organize a meeting about ${o.text}${o.participants?.length ? ` with ${o.participants.join(' and ')}` : ''}`);
        else if (o.op === 'plan' && o.text) translated.push(`plan ${o.text}${o.project ? ` in ${o.project}` : ''}`);
        else if (o.op === 'attention') translated.push('show me who needs my attention');
        else if (o.op === 'available') translated.push(`find an available ${o.role ?? 'employee'}`);
        else if (o.op === 'summary') translated.push('summarize what happened');
      }
      const operations: Planned[] = [];
      const problems: string[] = [];
      for (const sentence of translated) {
        const sub = this.plan(sentence);
        operations.push(...sub.operations);
        problems.push(...sub.problems);
      }
      if (operations.length && !problems.length) return { input, interpretedBy: 'claude-headless', operations, problems: [] };
    } catch (e) {
      this.core.log('warn', `headless command interpretation failed: ${(e as Error).message}`);
    }
    return plan;
  }

  /** Execute a confirmed plan. Every operation is re-validated against current state. */
  async execute(plan: CommandPlan, actor = 'owner'): Promise<CommandResult> {
    const result: CommandResult = { executed: [] };
    if (plan.problems?.length) throw new EngineError('this plan has unresolved problems and cannot be executed');
    this.core.audit(actor, 'command.execute', 'office', { input: plan.input, operations: plan.operations.map((o) => o.operation.op), interpretedBy: plan.interpretedBy });
    this.core.event({ type: 'owner.command', source: 'owner', summary: `Boss: ${truncate(plan.input, 160)}`, data: { operations: plan.operations.map((o) => o.operation.op), interpretedBy: plan.interpretedBy } });
    for (const { operation: op, description } of plan.operations) {
      try {
        const detail = await this.run(op, result);
        result.executed.push({ description, ok: true, ...detail });
      } catch (e) {
        result.executed.push({ description, ok: false, detail: (e as Error).message });
      }
    }
    return result;
  }

  private async run(op: Operation, result: CommandResult): Promise<{ detail: string; ref?: { kind: any; id: string } }> {
    const tasks = this.eng.tasks;
    switch (op.op) {
      case 'task.create': {
        if (!op.projectId) throw new EngineError('no project');
        const t = tasks.createTask({ projectId: op.projectId, title: op.title, description: op.description, assigneeId: op.assigneeId, roleHint: op.roleHint, kind: op.kind, priority: op.priority, released: op.start }, 'owner');
        return { detail: `${t.key} created (${t.status})`, ref: { kind: 'task', id: t.id } };
      }
      case 'task.assign': {
        const t = tasks.updateTask(op.taskId, { assigneeId: op.assigneeId, released: true });
        return { detail: `${t.key} assigned`, ref: { kind: 'task', id: t.id } };
      }
      case 'employee.message': {
        const msg = this.eng.comms.sendMessage({ from: { kind: 'owner', id: null, name: 'the boss' }, toEmployeeId: op.employeeId, body: op.body });
        return { detail: 'Message queued for delivery to their session', ref: { kind: 'message', id: msg.id } };
      }
      case 'employee.pause':
        await this.eng.sessions.pause(op.employeeId);
        return { detail: 'Interrupted (Escape sent to the terminal)', ref: { kind: 'employee', id: op.employeeId } };
      case 'employee.resume':
        await this.eng.sessions.resume(op.employeeId);
        return { detail: 'Resumed', ref: { kind: 'employee', id: op.employeeId } };
      case 'employee.report': {
        if (!this.core.runningSessionOf(op.employeeId)) throw new EngineError('that employee has no running session');
        const id = newId().slice(0, 8);
        this.eng.comms.deliver(op.employeeId, 'REPORT', id, { kind: 'report', id }, reportPrompt(id));
        return { detail: 'Report requested from their session; it will appear in the feed', ref: { kind: 'employee', id: op.employeeId } };
      }
      case 'project.pause': {
        const n = await this.eng.pauseProject(op.projectId);
        return { detail: `Paused; ${n} in-progress task${n === 1 ? '' : 's'} interrupted and returned to READY`, ref: { kind: 'project', id: op.projectId } };
      }
      case 'project.resume':
        tasks.updateProject(op.projectId, { status: 'active' });
        return { detail: 'Resumed', ref: { kind: 'project', id: op.projectId } };
      case 'project.move_team': {
        const moved = tasks.moveTeam(op.fromProjectId, op.toProjectId);
        return { detail: moved.length ? `Moved ${moved.map((e) => e.name).join(', ')}` : 'Nobody was assigned to that project', ref: { kind: 'project', id: op.toProjectId } };
      }
      case 'project.plan': {
        const t = tasks.planProject(op.projectId, op.objective, op.plannerId);
        return { detail: `${t.key} created for the planner`, ref: { kind: 'task', id: t.id } };
      }
      case 'meeting.create': {
        const m = this.eng.meetings.create({ topic: op.topic, projectId: op.projectId, participantIds: op.participantIds, facilitatorId: op.facilitatorId });
        return { detail: `Meeting ${m.id} started`, ref: { kind: 'meeting', id: m.id } };
      }
      case 'query.attention':
        result.answer = this.attention();
        return { detail: `${result.answer.lines.length} item(s)` };
      case 'query.available':
        result.answer = this.available(op.role);
        return { detail: `${result.answer.employeeIds?.length ?? 0} available` };
      case 'query.summary':
        result.answer = this.summary(op.since);
        return { detail: 'Summary ready' };
      case 'ui.focus':
        result.answer = { title: 'Go to desk', lines: [], employeeIds: [op.employeeId] };
        return { detail: 'Focusing', ref: { kind: 'employee', id: op.employeeId } };
    }
  }

  // ───────────────────────────── queries ───────────────────────────

  attention(): NonNullable<CommandResult['answer']> {
    const lines: string[] = [];
    const ids = new Set<string>();
    const name = (id: string | null) => this.core.employees.get(id)?.name ?? 'Someone';
    for (const q of this.core.questions.filter((x) => x.status === 'open')) {
      lines.push(`${q.kind === 'permission' ? '? APPROVAL' : '? QUESTION'} — ${name(q.employeeId)}: ${truncate(q.text, 140)}`);
      if (q.employeeId) ids.add(q.employeeId);
    }
    for (const t of this.core.tasks.filter((x) => x.status === 'BLOCKED')) {
      lines.push(`! BLOCKED — ${t.key} (${name(t.assigneeId)}): ${truncate(t.blockedReason ?? '', 140)}`);
      if (t.assigneeId) ids.add(t.assigneeId);
    }
    for (const t of this.core.tasks.filter((x) => x.status === 'REVIEW' && !this.core.tasks.find((r) => r.reviewOf === x.id && r.status !== 'DONE'))) {
      lines.push(`REVIEW — ${t.key} by ${name(t.assigneeId)} is waiting for your review`);
      if (t.assigneeId) ids.add(t.assigneeId);
    }
    for (const s of this.core.sessions.filter((x) => x.status === 'running' && !!x.employeeId)) {
      if ((s.activity === 'needs_approval' || s.activity === 'waiting_input' || s.activity === 'waiting_answer') && !ids.has(s.employeeId!)) {
        lines.push(`${ACTIVITY_LABEL[s.activity]} — ${name(s.employeeId)}${s.activityDetail ? `: ${truncate(s.activityDetail, 120)}` : ''}`);
        ids.add(s.employeeId!);
      }
    }
    for (const e of this.employees()) {
      const task = this.eng.tasks.currentTask(e.id);
      if (task && !this.core.runningSessionOf(e.id)) {
        lines.push(`OFFLINE — ${e.name}'s session is down while ${task.key} is in progress`);
        ids.add(e.id);
      }
    }
    const unreleased = this.core.tasks.filter((t) => !t.released && t.status === 'BACKLOG').length;
    if (unreleased) lines.push(`${unreleased} proposed task${unreleased === 1 ? '' : 's'} waiting for you to release them`);
    for (const h of this.core.hosts.filter((x) => x.status === 'offline' && !!this.core.employees.find((e) => e.hostId === x.id && !e.archived))) lines.push(`HOST OFFLINE — ${h.name}`);
    return { title: lines.length ? 'Waiting on you' : 'Nothing needs your attention right now', lines, employeeIds: [...ids] };
  }

  available(roleKey: string | null): NonNullable<CommandResult['answer']> {
    const free = this.employees().filter((e) => (!roleKey || e.roleKey === roleKey) && this.eng.tasks.isFree(e));
    const lines = free.map((e) => {
      const s = this.core.runningSessionOf(e.id);
      return `${e.name} — ${e.title} (${s ? 'at their desk, idle' : 'session not started; starts when given work'})`;
    });
    if (!free.length) {
      const busy = this.employees().filter((e) => !roleKey || e.roleKey === roleKey);
      lines.push(busy.length ? `No one free. ${busy.map((e) => `${e.name}: ${this.eng.tasks.currentTask(e.id)?.key ?? (this.core.agents.isOnline(e.hostId ?? '') ? 'unavailable' : 'host offline')}`).join('; ')}` : 'Nobody with that role is on the team.');
    }
    return { title: free.length ? `Available${roleKey ? ` (${roleKey})` : ''}` : 'Nobody available', lines, employeeIds: free.map((e) => e.id) };
  }

  /** A digest built only from recorded events — no generated narrative. */
  summary(since: string | null): NonNullable<CommandResult['answer']> {
    const from = since ?? new Date(Date.now() - 24 * 3600_000).toISOString();
    const events = this.core.store.queryEvents({
      since: from,
      limit: 2000,
      types: ['task.completed', 'task.blocked', 'task.started', 'task.verification_failed', 'task.merge_conflict', 'task.merged', 'task.review_completed', 'task.created', 'agent.question', 'agent.permission_requested', 'worker.disconnected', 'session.lost', 'meeting.concluded', 'progression.milestone', 'progression.level_up'],
    });
    const by = (type: string) => events.filter((e) => e.type === type);
    const lines: string[] = [];
    const completed = by('task.completed');
    lines.push(`${completed.length} task${completed.length === 1 ? '' : 's'} completed, ${by('task.started').length} started, ${by('task.created').length} created.`);
    for (const e of completed.slice(-8)) lines.push(`  ✓ ${e.summary}`);
    const failed = by('task.verification_failed');
    if (failed.length) lines.push(`${failed.length} verification failure${failed.length === 1 ? '' : 's'}: ${[...new Set(failed.map((e) => String(e.data.key)))].join(', ')}`);
    for (const e of by('task.blocked').slice(-5)) lines.push(`  ! ${e.summary}`);
    for (const e of by('task.merge_conflict').slice(-5)) lines.push(`  ! ${e.summary}`);
    const reviews = by('task.review_completed');
    if (reviews.length) lines.push(`${reviews.length} review${reviews.length === 1 ? '' : 's'} completed.`);
    const asked = by('agent.question').length + by('agent.permission_requested').length;
    const open = this.core.questions.filter((q) => q.status === 'open').length;
    if (asked || open) lines.push(`${asked} question${asked === 1 ? '' : 's'}/approval request${asked === 1 ? '' : 's'} raised; ${open} still open.`);
    for (const e of by('meeting.concluded').slice(-3)) lines.push(`  • ${e.summary}`);
    const lost = [...by('session.lost'), ...by('worker.disconnected')];
    if (lost.length) lines.push(`${lost.length} session/host disconnection${lost.length === 1 ? '' : 's'}.`);
    for (const e of [...by('progression.milestone'), ...by('progression.level_up')].slice(-4)) lines.push(`  ★ ${e.summary}`);
    return { title: `Since ${new Date(from).toLocaleString()}`, lines };
  }

  touchLastSeen(): void {
    this.core.updateSettings({ lastSeenAt: nowIso() });
  }
}
