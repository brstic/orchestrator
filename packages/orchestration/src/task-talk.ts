import type { AgentSession, Employee, QuestionOption, Task, TaskComment, TaskMention } from '@orchestrator/contracts';
import { TASK_COMMENTS_MAX, newId, nowIso, optionsIn, redactSecrets, truncate } from '@orchestrator/contracts';
import { EngineError } from './core.ts';
import type { Engine } from './engine.ts';

/** A person of the office, as a route knows them. */
export interface Person {
  kind: 'owner' | 'member';
  id: string | null;
  name: string;
}

/** One part of a task that is being split, as its assignee describes it. */
export interface PartSpec {
  title: string;
  description: string;
  acceptance?: string;
  kind?: string;
  /** The colleague it is for, by name. Without one: one of the colleagues put on the task, else whoever fits. */
  assignee?: string;
}

/** How many parts a task can be divided into at once, and have open at a time. */
export const PARTS_AT_ONCE = 6;
export const PARTS_OPEN = 8;

const actorOf = (p: Person) => (p.kind === 'owner' ? 'owner' : `member:${p.name}`);
const said = (p: Person) => (p.kind === 'owner' ? 'the boss' : p.name);

/**
 * The conversation on a task, and what follows from it (`docs/TASKS.md`): comments by people and employees with
 * tags, questions the work waits for ("asking instead of blocking"), sending a task back, and a task divided into
 * parts that colleagues work on together.
 */
export class TaskTalk {
  private eng: Engine;
  /** Calls that wait for a colleague's answer to a question asked on a task (by the question's comment). */
  private waiters = new Map<string, Set<(answer: TaskComment | null) => void>>();

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  // ───────────────────────────── the record ─────────────────────────────

  /** Add an entry to a task's conversation. The caller stores the task when it changes more than this. */
  add(task: Task, c: Pick<TaskComment, 'from' | 'body' | 'kind'> & Partial<Pick<TaskComment, 'mentions' | 'questionId' | 'answerTo' | 'options' | 'attachmentIds'>>, opts: { quiet?: boolean; store?: boolean } = {}): TaskComment {
    const comment: TaskComment = {
      id: newId(),
      ts: nowIso(),
      from: c.from,
      body: truncate(c.body.trim(), 8000),
      kind: c.kind,
      mentions: c.mentions ?? [],
      ...(c.kind === 'question' ? { answeredBy: null } : {}),
      ...(c.questionId ? { questionId: c.questionId } : {}),
      ...(c.answerTo ? { answerTo: c.answerTo } : {}),
      ...(c.options?.length ? { options: c.options } : {}),
      ...(c.attachmentIds?.length ? { attachmentIds: c.attachmentIds } : {}),
    };
    task.comments = [...(task.comments ?? []), comment];
    if (task.comments.length > TASK_COMMENTS_MAX) task.comments.splice(0, task.comments.length - TASK_COMMENTS_MAX);
    task.updatedAt = nowIso();
    if (opts.store !== false) this.core.put('task', task);
    this.core.event({
      type: 'task.commented',
      source: c.from.kind === 'employee' ? 'mcp' : c.from.kind === 'office' ? 'server' : 'owner',
      summary: `${c.from.name} ${WORDS[c.kind]} ${task.key}: ${truncate(redactSecrets(comment.body), 140)}`,
      taskId: task.id,
      projectId: task.projectId,
      employeeId: c.from.kind === 'employee' ? c.from.id : task.assigneeId,
      data: { key: task.key, commentId: comment.id, kind: c.kind, quiet: opts.quiet === true || c.from.kind === 'office' },
    });
    return comment;
  }

  /** The question of this task that is still waiting for an answer: the one the task is parked on, else the latest. */
  openQuestion(task: Task): TaskComment | undefined {
    const open = (task.comments ?? []).filter((c) => c.kind === 'question' && !c.answeredBy);
    const parked = task.waitingFor?.kind === 'answer' ? task.waitingFor.commentId : null;
    return open.find((c) => c.id === parked) ?? open[open.length - 1];
  }

  /**
   * Who a text is addressed to: `@Name` for an employee (a name may have spaces — the longest name that matches
   * wins; a first name is enough when it is nobody else's), `@boss` / `@owner` / the owner's name for the people of
   * the office. `also`: names given beside the text. `unknown`: tags that are nobody's.
   */
  mentionsIn(text: string, also: string[] = []): { mentions: TaskMention[]; unknown: string[] } {
    const employees = this.core.employees.filter((e) => !e.archived).sort((a, b) => b.name.length - a.name.length);
    const bosses = ['boss', 'the boss', 'owner', 'the owner', this.core.settings.ownerName.toLowerCase()].filter(Boolean);
    const mentions: TaskMention[] = [];
    const unknown: string[] = [];
    const take = (m: TaskMention) => {
      if (m.kind === 'boss' ? !mentions.some((x) => x.kind === 'boss') : !mentions.some((x) => x.kind === 'employee' && x.id === m.id)) mentions.push(m);
    };
    const named = (raw: string): boolean => {
      const rest = raw.toLowerCase();
      const ends = (n: number) => !/[\p{L}\p{N}_]/u.test(rest.charAt(n));
      const full = employees.find((e) => rest.startsWith(e.name.toLowerCase()) && ends(e.name.length));
      if (full) return take({ kind: 'employee', id: full.id, name: full.name }), true;
      const boss = bosses.sort((a, b) => b.length - a.length).find((b) => rest.startsWith(b) && ends(b.length));
      if (boss) return take({ kind: 'boss' }), true;
      const word = /^[\p{L}\p{N}_.-]+/u.exec(raw)?.[0]?.replace(/[.-]+$/, '') ?? '';
      const one = word ? this.core.employeeByName(word) : undefined;
      if (one) return take({ kind: 'employee', id: one.id, name: one.name }), true;
      if (word) unknown.push(word);
      return false;
    };
    // (Bounded: a text is not searched for more tags than anybody writes.)
    let at = -1;
    for (let n = 0; n < 40 && (at = text.indexOf('@', at + 1)) !== -1; n++) {
      // An address, not a tag: something@somewhere.
      if (at > 0 && /[\p{L}\p{N}._-]/u.test(text.charAt(at - 1))) continue;
      named(text.slice(at + 1, at + 80));
    }
    for (const name of also.slice(0, 12)) if (typeof name === 'string' && name.trim()) named(name.trim().replace(/^@/, ''));
    return { mentions, unknown: [...new Set(unknown)] };
  }

  /** The last of the conversation, as an employee reads it in a task they are given. */
  threadText(task: Task, last = 12): string {
    const list = (task.comments ?? []).slice(-last);
    if (!list.length) return '';
    return list.map((c) => `- ${c.ts.slice(0, 16).replace('T', ' ')} ${c.from.name}${LABEL[c.kind] ? ` (${LABEL[c.kind]})` : ''}: ${truncate(c.body, 1200)}`).join('\n');
  }

  /** What a task's prompt says beyond the task itself: who is on it, what it is a part of, what was said on it. */
  promptLines(task: Task, employee: Employee): string[] {
    const out: string[] = [];
    const parent = task.parentId ? this.core.tasks.get(task.parentId) : undefined;
    if (parent) {
      const lead = this.core.employees.get(parent.assigneeId);
      out.push(
        `This is one part of ${parent.key} "${truncate(parent.title, 100)}"${lead && lead.id !== employee.id ? `, which ${lead.name} leads` : ''}. Do this part only. When something about it is unclear or touches the other parts, say so on the ticket — comment_on_task with task "${task.key}"${lead && lead.id !== employee.id ? `, tagging @${lead.name}` : ''} — rather than guessing.`,
      );
    }
    const helpers = (task.helperIds ?? []).map((id) => this.core.employees.get(id)).filter((e): e is Employee => !!e && !e.archived && e.id !== employee.id);
    if (helpers.length && !task.parentId) {
      out.push(
        `The boss put ${helpers.map((e) => `${e.name} (${e.title})`).join(', ')} on this ticket with you; you lead it. Divide the work with split_task: one clear, independent part per colleague (what to do, where, how to tell it is done), and keep a part for yourself. Talk on the ticket with comment_on_task, tagging them by name.`,
      );
    }
    const parts = this.partsOf(task);
    if (parts.length) out.push(`Its parts: ${parts.map((p) => `${p.key} [${p.status}] ${truncate(p.title, 60)}${p.assigneeId ? ` — ${this.core.employees.get(p.assigneeId)?.name ?? 'somebody'}` : ''}`).join('; ')}.`);
    const thread = this.threadText(task);
    if (thread) out.push(`The conversation on this ticket so far (newest last):\n${thread}`);
    return out;
  }

  partsOf(task: Task): Task[] {
    return this.core.tasks.filter((t) => t.parentId === task.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ───────────────────────── bringing a comment to somebody ─────────────────────────

  /** May `from` tag `to` on this task? The words to refuse with, or null. (The rules a message between them has.) */
  private cannotTag(from: Employee | null, to: Employee, task: Task): string | null {
    if (to.archived) return `${to.name} no longer works here.`;
    if (!this.eng.tasks.canSee(to, task)) return `${to.name} cannot be brought into ${task.key}: work does not cross between the shared office and a member's own computer.`;
    if (!from) return null;
    if (to.roleKey === 'foreman' && from.roleKey !== 'foreman') return `${to.name} is the foreman: the office calls it when something needs it. Tag the boss instead.`;
    const member = this.eng.hosts.memberOfHost(to.hostId);
    if (member && this.eng.hosts.memberOfHost(from.hostId) !== member && this.eng.hosts.isClosed(member)) return `${to.name} works on a member's own computer, and that member has closed their room: nothing reaches them from outside until it is open again.`;
    return null;
  }

  private tell(to: Employee, task: Task, from: TaskComment['from'], text: string): void {
    this.eng.comms.sendMessage({
      from: from.kind === 'employee' ? { kind: 'employee', id: from.id, name: from.name } : from.kind === 'office' ? { kind: 'system', id: null, name: 'the office' } : { kind: 'owner', id: null, name: from.name },
      toEmployeeId: to.id,
      kind: 'comment',
      taskId: task.id,
      body: text,
    });
  }

  private howToAnswer(task: Task): string {
    return `Answer on the ticket: comment_on_task with task "${task.key}".`;
  }

  // ─────────────────────────────── people ───────────────────────────────

  /**
   * A person wrote on a task. If the task waits for an answer, this is the answer (and the task goes back to its
   * employee with it); otherwise it is a comment — brought at once to whoever is working on the task, and to
   * everybody tagged in it.
   */
  async byPerson(taskId: string, text: string, who: Person, fileIds: unknown = []): Promise<Task> {
    const task = this.core.tasks.require(taskId);
    // Files of the task that go with the comment (attached in the box where it was written): shown under it.
    const attachmentIds = [...new Set((Array.isArray(fileIds) ? fileIds : []).map(String))].filter((id) => (task.attachments ?? []).some((a) => a.id === id)).slice(0, 20);
    // (A picture can be the whole comment.)
    const raw = String(text ?? '').trim() || (attachmentIds.length ? 'Look at this.' : '');
    if (!raw) throw new EngineError('write the comment first');
    const from = { kind: who.kind, id: who.id, name: who.kind === 'owner' ? 'The boss' : who.name } as const;
    const open = this.openQuestion(task);
    const question = open?.questionId ? this.core.questions.get(open.questionId) : undefined;
    // Asked of the boss through the office's own question: answering here is answering that (one answer, one place).
    if (open && question?.status === 'open') {
      await this.eng.comms.answer(question.id, { answer: raw }, actorOf(who));
      const now = this.core.tasks.require(taskId);
      const written = attachmentIds.length ? (now.comments ?? []).find((c) => c.answerTo === open.id) : undefined;
      if (written) {
        written.attachmentIds = attachmentIds;
        this.core.put('task', now);
      }
      return now;
    }
    const body = this.eng.vault.capture(truncate(raw, 8000), { kind: 'owner', id: null, name: said(who) }, [this.core.projects.get(task.projectId)?.name ?? '']).text;
    const { mentions } = this.mentionsIn(body);
    const parked = task.status === 'BLOCKED' && task.waitingFor?.kind === 'answer' && open && open.id === task.waitingFor.commentId;
    // A task its employee marked blocked (or parked on a question to a colleague): the boss's word is the answer.
    if (open && (parked || task.status === 'BLOCKED')) {
      this.answered(task, open, { from, body, mentions, attachmentIds });
      if (task.status === 'BLOCKED') this.eng.tasks.unblock(task.id, body, actorOf(who), undefined, { threaded: true });
      return this.core.tasks.require(taskId);
    }
    const comment = this.add(task, { from, body, kind: 'note', mentions, attachmentIds });
    const told = new Set<string>();
    const assignee = this.core.employees.get(task.assigneeId);
    if (task.status === 'IN_PROGRESS' && assignee && !assignee.archived) {
      this.tell(assignee, task, from, `Comment from ${said(who)} on ${task.key} "${truncate(task.title, 100)}", which you are working on:\n${comment.body}\n\nTake it into account and go on with the task. If it needs an answer, ${this.howToAnswer(task).replace(/^Answer/, 'answer')}`);
      told.add(assignee.id);
    }
    for (const m of mentions) {
      if (m.kind !== 'employee' || told.has(m.id)) continue;
      const to = this.core.employees.get(m.id);
      if (!to || this.cannotTag(null, to, task)) continue;
      this.tell(to, task, from, `${said(who)[0]!.toUpperCase()}${said(who).slice(1)} tagged you on ${task.key} "${truncate(task.title, 100)}":\n${comment.body}\n\n${this.howToAnswer(task)}`);
      told.add(to.id);
    }
    return task;
  }

  // ────────────────────────────── employees ─────────────────────────────

  /**
   * An employee wrote on a task (the `comment_on_task` tool). Plain: recorded, and brought to everybody tagged.
   * `ask`: they cannot go on without the answer — the call waits for it for a while, and if none comes the task is
   * parked until it does.
   */
  async byEmployee(employee: Employee, session: AgentSession, a: { task?: string; text: string; to?: string[]; ask?: boolean; options?: QuestionOption[]; context?: string; why?: string; files?: string[] }, signal?: AbortSignal): Promise<{ text: string; isError?: boolean }> {
    const err = (text: string) => ({ text, isError: true });
    const current = this.eng.tasks.currentTask(employee.id);
    let task = current;
    if (a.task) {
      const t = this.eng.tasks.taskByKey(String(a.task), employee.projectId);
      if (!t || !this.eng.tasks.canSee(employee, t)) return err(`No task "${a.task}" that you can see.`);
      task = t;
    }
    if (!task) return err('You have no task in progress: say which ticket with "task" (its key, e.g. "T-12").');
    const raw = String(a.text ?? '').trim();
    if (!raw) return err('Write the comment in "text".');
    const from = { kind: 'employee' as const, id: employee.id, name: employee.name };
    const body = this.eng.vault.capture(truncate(raw, 8000), { kind: 'employee', id: employee.id, name: employee.name }, [this.core.projects.get(task.projectId)?.name ?? '']).text;
    const found = this.mentionsIn(body, Array.isArray(a.to) ? a.to.map(String) : []);
    const refused: string[] = [];
    const mentions = found.mentions.filter((m) => {
      if (m.kind === 'boss') return true;
      if (m.id === employee.id) return false;
      const no = this.cannotTag(employee, this.core.employees.get(m.id)!, task!);
      if (no) refused.push(no);
      return !no;
    });
    const notes = [...refused, ...(found.unknown.length ? [`Nobody here is called ${found.unknown.map((u) => `"${u}"`).join(', ')} (get_team shows who is).`] : [])];
    // Pictures and files that go with what is said: the ones named, and any picture whose path stands in the text
    // (a path on the employee's machine shows nobody anything — the file itself is put on the task).
    const attachmentIds = await this.attach(task, employee, a.files ?? [], body, notes);
    const given = (Array.isArray(a.options) ? a.options : []).filter((o) => o && typeof o.label === 'string' && o.label.trim()).slice(0, 6).map((o) => ({ label: truncate(String(o.label).trim(), 200), ...(o.description ? { description: truncate(String(o.description), 600) } : {}), ...(o.consequence ? { consequence: truncate(String(o.consequence), 600) } : {}) }));
    // (Choices written into the question itself — "A) … B) …" — are choices all the same.)
    const options: QuestionOption[] = given.length ? given : a.ask === true ? optionsIn(body) : [];

    if (a.ask === true) {
      if (!current || current.id !== task.id) return err(`You can only ask-and-wait on the ticket you are working on${current ? ` (${current.key})` : ''}. On another ticket, comment without "ask" and tag whoever should answer.`);
      const to = mentions.length ? mentions : [{ kind: 'boss' } as TaskMention];
      const toBoss = to.some((m) => m.kind === 'boss');
      // The same question to the boss once more (the call that waited was cut off): it is the one already asked.
      const again = toBoss ? this.eng.comms.sameQuestion(employee.id, body, task.id) : undefined;
      let comment = again ? (task.comments ?? []).find((c) => c.questionId === again.id) : undefined;
      if (again?.status === 'answered') {
        this.eng.comms.cancelFor({ kind: 'question', id: again.id });
        this.eng.comms.answerReturnedByTool(again.id);
        return { text: `The boss answered: ${again.answer ?? ''}` };
      }
      if (!comment) {
        comment = this.add(task, { from, body, kind: 'question', mentions: to, options, attachmentIds }, { store: false });
        if (toBoss) {
          const q = this.eng.comms.createQuestion({ kind: options.length ? 'decision' : 'question', channel: 'mcp_tool', employee, session, text: truncate(body, 4000), context: a.context ? truncate(String(a.context), 8000) : '', why: a.why ? truncate(String(a.why), 2000) : '', options, taskId: task.id, projectId: task.projectId, onTask: true });
          comment.questionId = q.id;
        }
        this.core.put('task', task);
        for (const m of to) {
          if (m.kind !== 'employee') continue;
          const colleague = this.core.employees.get(m.id)!;
          this.tell(colleague, task, from, `${employee.name} (${employee.title}) asks you on ${task.key} "${truncate(task.title, 100)}" and cannot go on without your answer:\n${comment.body}\n\nAnswer before anything else: comment_on_task with task "${task.key}" and your answer in "text". Then carry on with your own work.`);
          // Somebody who is not at their desk is brought in for it: the one who asks is waiting.
          if (!this.core.runningSessionOf(colleague.id)) void this.eng.sessions.start(colleague.id, { actor: `employee:${employee.name}` }).catch(() => undefined);
        }
      }
      // Waiting for the boss is "needs a decision"; waiting for a colleague is waiting, said with whom — the owner is
      // not the one it waits for (the label used to say "? NEEDS A DECISION" for both).
      if (toBoss) this.eng.sessions.setActivity(session, 'waiting_answer', truncate(body, 120));
      else this.eng.sessions.setActivity(session, 'waiting_input', `Waiting for ${to.map((m) => (m.kind === 'employee' ? (this.core.employees.get(m.id)?.name ?? 'a colleague') : 'a colleague')).join(' and ')}'s answer on ${task.key}`);
      const answer = await this.waitForAnswer(task.id, comment, this.core.timings.askBossWaitMs, signal);
      if (answer) return { text: `${answer.from.kind === 'employee' ? answer.from.name : 'The boss'} answered: ${answer.body}` };
      if (signal?.aborted) return err('The call was cut off before an answer came. Ask again with the same words to go on waiting.');
      return { text: this.park(task.id, employee, comment) };
    }

    // Is this the answer to something this employee was asked on the ticket?
    const asked = (task.comments ?? []).filter((c) => c.kind === 'question' && !c.answeredBy && c.from.id !== employee.id && c.mentions.some((m) => m.kind === 'employee' && m.id === employee.id))[0];
    if (asked) {
      const answer = this.answered(task, asked, { from, body, mentions, attachmentIds });
      const parked = task.status === 'BLOCKED' && task.waitingFor?.kind === 'answer' && task.waitingFor.commentId === asked.id;
      const waited = this.wake(asked.id, answer);
      if (parked) this.eng.tasks.unblock(task.id, body, `employee:${employee.name}`, employee, { threaded: true });
      else if (!waited) {
        const asker = this.core.employees.get(asked.from.id);
        if (asker && !asker.archived) this.tell(asker, task, from, `${employee.name} answered your question on ${task.key}:\n${answer.body}`);
      }
      this.eng.foreman.noteMessage(employee);
      return { text: `Your answer is on ${task.key}${parked ? `, and the ticket is back with ${this.core.employees.get(task.assigneeId)?.name ?? 'its employee'}` : ''}.${notes.length ? ` ${notes.join(' ')}` : ''}` };
    }

    const comment = this.add(task, { from, body, kind: 'note', mentions, attachmentIds });
    const told: string[] = [];
    const reached = new Set<string>();
    for (const m of mentions) {
      if (m.kind === 'boss') {
        this.eng.comms.notify({ kind: 'mention', severity: 'info', title: `${employee.name} tagged you on ${task.key}`, body: truncate(comment.body, 400), employeeId: employee.id, taskId: task.id, projectId: task.projectId });
        told.push('the boss');
        continue;
      }
      const to = this.core.employees.get(m.id)!;
      this.tell(to, task, from, `${employee.name} (${employee.title}) tagged you on ${task.key} "${truncate(task.title, 100)}":\n${comment.body}\n\n${this.howToAnswer(task)} Then carry on with your own work.`);
      told.push(to.name);
      reached.add(to.id);
    }
    // Somebody else's ticket that is being worked on: whoever works on it reads what was said on it.
    const assignee = this.core.employees.get(task.assigneeId);
    if (task.status === 'IN_PROGRESS' && assignee && assignee.id !== employee.id && !reached.has(assignee.id) && !this.cannotTag(employee, assignee, task)) {
      this.tell(assignee, task, from, `${employee.name} (${employee.title}) commented on ${task.key}, which you are working on:\n${comment.body}\n\nTake it into account. If it needs an answer, ${this.howToAnswer(task).replace(/^Answer/, 'answer')}`);
      told.push(assignee.name);
    }
    if (told.length) this.eng.foreman.noteMessage(employee);
    return { text: `Comment added to ${task.key}${told.length ? ` — ${told.join(', ')} ${told.length === 1 ? 'is' : 'are'} told` : ' (nobody was tagged, so nobody is told; tag @boss or a colleague when somebody should read it)'}.${notes.length ? ` ${notes.join(' ')}` : ''}` };
  }

  /**
   * Put on the task the files that go with a comment: the paths the employee named, and pictures whose paths stand
   * in the text. Returns their ids. What cannot be read is said for a file that was named, and passed over for one
   * that was only found in the text.
   */
  private async attach(task: Task, employee: Employee, named: string[], text: string, notes: string[]): Promise<string[]> {
    if (!this.eng.attachments.available()) return [];
    const wanted = new Map<string, boolean>();
    for (const f of named.slice(0, 8)) if (typeof f === 'string' && f.trim()) wanted.set(f.trim(), true);
    for (const m of text.matchAll(/(?:^|[\s("'`])((?:~|\.{1,2})?\/[^\s"'`()<>]{1,400}?\.(?:png|jpe?g|gif|webp))(?=$|[\s"'`).,;:!?])/gi)) if (wanted.size < 8 && !wanted.has(m[1]!)) wanted.set(m[1]!, false);
    const ids: string[] = [];
    for (const [file, asked] of wanted) {
      try {
        ids.push((await this.eng.attachments.attachFrom(task, employee, file, null)).id);
      } catch (e) {
        if (asked) notes.push(`${file} was not attached: ${(e as Error).message}`);
      }
    }
    return ids;
  }

  /** A question on a task got its answer: the answer is written under it. */
  private answered(task: Task, question: TaskComment, a: Pick<TaskComment, 'from' | 'body' | 'mentions'> & Partial<Pick<TaskComment, 'attachmentIds'>>): TaskComment {
    const answer = this.add(task, { ...a, kind: 'answer', answerTo: question.id }, { store: false });
    const q = (task.comments ?? []).find((c) => c.id === question.id);
    if (q) q.answeredBy = answer.id;
    this.core.put('task', task);
    // (Asked of the boss as one of the office's questions, and answered some other way: that question is closed.)
    const office = question.questionId ? this.core.questions.get(question.questionId) : undefined;
    if (office?.status === 'open') this.eng.comms.supersede(office.id, `Answered on ${task.key}`);
    return answer;
  }

  private wake(commentId: string, answer: TaskComment | null): boolean {
    const set = this.waiters.get(commentId);
    if (!set?.size) return false;
    this.waiters.delete(commentId);
    for (const fn of set) fn(answer);
    return true;
  }

  /** Wait until a question asked on a task is answered — by the boss (the office's question) or by a colleague's comment. */
  private waitForAnswer(taskId: string, question: TaskComment, timeoutMs: number, signal?: AbortSignal): Promise<TaskComment | null> {
    const find = () => {
      const q = (this.core.tasks.get(taskId)?.comments ?? []).find((c) => c.id === question.id);
      return q?.answeredBy ? ((this.core.tasks.get(taskId)?.comments ?? []).find((c) => c.id === q.answeredBy) ?? null) : null;
    };
    const already = find();
    if (already) return Promise.resolve(already);
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let set = this.waiters.get(question.id);
      if (!set) this.waiters.set(question.id, (set = new Set()));
      const done = (answer: TaskComment | null) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', gone);
        set!.delete(done);
        if (!set!.size && this.waiters.get(question.id) === set) this.waiters.delete(question.id);
        resolve(answer);
      };
      const gone = () => done(null);
      const timer = setTimeout(() => done(find()), timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', gone, { once: true });
      set.add(done);
    });
  }

  /** Is a `comment_on_task` call waiting, right now, for the answer to this one of the office's questions? */
  hasWaiterFor(q: { id: string; taskId: string | null }): boolean {
    const comment = q.taskId ? (this.core.tasks.get(q.taskId)?.comments ?? []).find((c) => c.questionId === q.id) : undefined;
    return !!comment && (this.waiters.get(comment.id)?.size ?? 0) > 0;
  }

  /** No answer came while the employee waited: the task waits for it without them. Returns what they are told. */
  private park(taskId: string, employee: Employee, question: TaskComment): string {
    const task = this.core.tasks.get(taskId);
    if (!task || task.status !== 'IN_PROGRESS' || task.assigneeId !== employee.id) return 'No answer yet. Go on with what does not depend on it.';
    const of = question.mentions.map((m) => (m.kind === 'boss' ? 'the boss' : m.name)).join(', ') || 'the boss';
    task.status = 'BLOCKED';
    task.waitingFor = { kind: 'answer', commentId: question.id };
    task.blockedReason = `Waiting for an answer from ${of}: ${truncate(question.body, 300)}`;
    task.friction.questions += question.questionId ? 0 : 1;
    this.eng.tasks.note(task, `Waiting for an answer from ${of}`, `employee:${employee.name}`);
    this.core.put('task', task);
    this.core.event({ type: 'task.blocked', source: 'mcp', summary: `${task.key} waits for an answer from ${of}`, taskId: task.id, projectId: task.projectId, employeeId: employee.id, data: { key: task.key, reason: task.blockedReason, waiting: 'answer', quiet: true } });
    const session = this.core.runningSessionOf(employee.id);
    if (session) this.eng.sessions.setActivity(session, 'idle', null);
    this.eng.tasks.schedule();
    return `No answer from ${of} yet. ${task.key} now waits for it, and so do you: stop working on it, do not guess, and do not start anything else — no new task is given to you while your question is open. ${task.key} comes back to you with the answer.`;
  }

  // ────────────────────── the office's own questions, mirrored ──────────────────────

  /** `ask_boss` on a task: the question is part of that task's conversation too. */
  questionAsked(q: { id: string; kind: string; channel: string; taskId: string | null; employeeId: string | null; text: string; options?: QuestionOption[] }): void {
    if ((q.kind !== 'question' && q.kind !== 'decision') || q.channel !== 'mcp_tool' || !q.taskId || !q.employeeId) return;
    const task = this.core.tasks.get(q.taskId);
    const employee = this.core.employees.get(q.employeeId);
    if (!task || !employee || (task.comments ?? []).some((c) => c.questionId === q.id)) return;
    this.add(task, { from: { kind: 'employee', id: employee.id, name: employee.name }, body: q.text, kind: 'question', mentions: [{ kind: 'boss' }], questionId: q.id, options: q.options });
  }

  /**
   * One of the office's questions was answered (in the Inbox, on the ticket, by the foreman): the answer is written
   * on the task it was asked on. If the task was parked on it, it goes back to its employee with the answer —
   * `true`, and the answer is not also delivered on its own.
   */
  questionAnswered(q: { id: string; taskId: string | null; answer: string | null; answeredBy?: { kind: string; id: string | null; name: string } | null }, actor: string): boolean {
    const task = q.taskId ? this.core.tasks.get(q.taskId) : undefined;
    const question = task ? (task.comments ?? []).find((c) => c.questionId === q.id) : undefined;
    if (!task || !question || question.answeredBy) return false;
    const from: TaskComment['from'] = q.answeredBy?.kind === 'foreman' ? { kind: 'employee', id: q.answeredBy.id, name: q.answeredBy.name } : actor === 'owner' ? { kind: 'owner', id: null, name: 'The boss' } : { kind: 'member', id: null, name: actor.replace(/^[a-z]+:/, '') };
    const answer = this.add(task, { from, body: q.answer ?? '', kind: 'answer', answerTo: question.id, mentions: [] }, { store: false });
    question.answeredBy = answer.id;
    this.core.put('task', task);
    this.wake(question.id, answer);
    if (task.status === 'BLOCKED' && task.waitingFor?.kind === 'answer' && task.waitingFor.commentId === question.id) {
      this.eng.tasks.unblock(task.id, answer.body, actor, undefined, { threaded: true });
      return true;
    }
    return false;
  }

  /**
   * `report_blocker`: said on the task, as a question to the boss — what is written there next is the answer. (The
   * task is not marked as waiting for it: a reported blocker stays an alarm, and reads "Blocked on" to colleagues.)
   */
  blocked(task: Task, employee: Employee, reason: string): void {
    this.add(task, { from: { kind: 'employee', id: employee.id, name: employee.name }, body: reason, kind: 'question', mentions: [{ kind: 'boss' }] }, { store: false, quiet: true });
  }

  /** A blocked task was unblocked some other way (the Unblock button, a colleague's `unblock_task`): its question is closed with what was said. */
  unblocked(task: Task, note: string, from: TaskComment['from']): void {
    const open = this.openQuestion(task);
    if (!open) return;
    const answer = this.answered(task, open, { from, body: note || 'Unblocked.', mentions: [] });
    this.wake(open.id, answer);
  }

  // ─────────────────────────────── sending back ───────────────────────────────

  /**
   * A person sends a task back with what should change. In review: changes are requested. Done: it is opened again
   * for its author. Blocked: the note is the answer. In progress: a correction, delivered now. Otherwise: a comment.
   */
  async sendBack(taskId: string, text: string, who: Person): Promise<Task> {
    const task = this.core.tasks.require(taskId);
    const note = String(text ?? '').trim();
    if (!note) throw new EngineError('say what should change: it is what the employee reads');
    if (task.kind === 'review') throw new EngineError('a review is not sent back; send back the task it reviews');
    switch (task.status) {
      case 'REVIEW':
        return this.eng.tasks.submitReview('owner', task.id, 'request_changes', note, who);
      case 'DONE':
        return this.eng.tasks.reopen(task.id, note, who);
      case 'BLOCKED':
        return this.byPerson(task.id, note, who);
      case 'IN_PROGRESS': {
        const body = this.eng.vault.capture(truncate(note, 4000), { kind: 'owner', id: null, name: said(who) }, []).text;
        this.add(task, { from: { kind: who.kind, id: who.id, name: who.kind === 'owner' ? 'The boss' : who.name }, body, kind: 'sent_back', mentions: [] });
        await this.eng.tasks.correctTask(task.id, { note: body, now: true }, actorOf(who));
        return this.core.tasks.require(taskId);
      }
      default:
        return this.byPerson(task.id, note, who);
    }
  }

  // ───────────────────────── several employees on one task ─────────────────────────

  /** The colleagues a person puts on a task with its assignee. The assignee, if at work on it, is told. */
  setHelpers(task: Task, ids: unknown, actor: string): void {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 8);
    const before = new Set(task.helperIds ?? []);
    for (const id of list) {
      const e = this.core.employees.require(id);
      if (e.archived) throw new EngineError(`${e.name} no longer works here`);
      if (id === task.assigneeId) throw new EngineError(`${e.name} already has ${task.key}: the others are put on it with them`);
      this.eng.tasks.mayTake(e, task);
    }
    task.helperIds = list;
    const added = list.filter((id) => !before.has(id)).map((id) => this.core.employees.get(id)!);
    if (!added.length) return;
    this.eng.tasks.note(task, `${added.map((e) => e.name).join(', ')} put on the task with its assignee`, actor);
    const lead = this.core.employees.get(task.assigneeId);
    if (task.status === 'IN_PROGRESS' && lead && !task.parentId) {
      this.tell(lead, task, { kind: 'office', id: null, name: 'The office' }, `${added.map((e) => `${e.name} (${e.title})`).join(', ')} ${added.length === 1 ? 'was' : 'were'} put on ${task.key} "${truncate(task.title, 100)}" with you. Divide the work with split_task: one clear, independent part per colleague, and keep a part for yourself. Talk on the ticket with comment_on_task, tagging them by name.`);
    }
  }

  /** The assignee of a task in progress divides it: each part becomes a task of its own, for a colleague. */
  split(employee: Employee, specs: unknown): { text: string; isError?: boolean } {
    const err = (text: string) => ({ text, isError: true });
    const task = this.eng.tasks.currentTask(employee.id);
    if (!task) return err('You have no task in progress to split.');
    if (task.parentId) return err(`${task.key} is itself a part of ${this.core.tasks.get(task.parentId)?.key ?? 'another task'}: parts are not split again. If it is too much, say so on the ticket (comment_on_task, tagging whoever leads it).`);
    if (task.kind === 'review') return err('A review is not split.');
    const list = (Array.isArray(specs) ? specs : []).filter((p): p is PartSpec => !!p && typeof p === 'object');
    if (!list.length) return err('Give the parts: [{ title, description, assignee? }, …].');
    if (list.length > PARTS_AT_ONCE) return err(`At most ${PARTS_AT_ONCE} parts at once. Fewer, larger parts are easier to bring together.`);
    const open = this.partsOf(task).filter((p) => p.status !== 'DONE');
    if (open.length + list.length > PARTS_OPEN) return err(`${task.key} already has ${open.length} open part${open.length === 1 ? '' : 's'}; it can have ${PARTS_OPEN} at a time.`);
    const helpers = (task.helperIds ?? []).map((id) => this.core.employees.get(id)).filter((e): e is Employee => !!e && !e.archived);
    const busy = new Map<string, number>();
    const plan: Array<{ spec: PartSpec; to: Employee | null }> = [];
    for (const [i, spec] of list.entries()) {
      const title = String(spec.title ?? '').trim();
      const description = String(spec.description ?? '').trim();
      if (!title) return err(`Part ${i + 1} has no title.`);
      if (description.length < 20) return err(`Part ${i + 1} ("${truncate(title, 40)}") needs a real description: what to do, where, and how to tell it is done. Whoever gets it has only that.`);
      let to: Employee | null = null;
      if (spec.assignee && String(spec.assignee).trim()) {
        const named = this.eng.comms.resolveTeammate(employee, String(spec.assignee).replace(/^@/, ''));
        if (!named || named.archived) return err(`No colleague matches "${spec.assignee}" (part ${i + 1}). Use get_team; a part for yourself stays in ${task.key}.`);
        to = named;
      } else if (helpers.length) {
        // Whoever of the colleagues on the task has the fewest parts so far.
        to = [...helpers].sort((x, y) => (busy.get(x.id) ?? 0) - (busy.get(y.id) ?? 0))[0]!;
      }
      if (to) {
        try {
          this.eng.tasks.mayTake(to, task);
        } catch (e) {
          return err(`Part ${i + 1}: ${(e as Error).message}`);
        }
        if (!to.hostId) return err(`Part ${i + 1}: ${to.name} has no machine to work on.`);
        busy.set(to.id, (busy.get(to.id) ?? 0) + 1);
      }
      plan.push({ spec: { ...spec, title, description }, to });
    }
    // (Checked for all before anything is made: a split that is refused leaves nothing behind.)
    for (const p of plan) {
      const cannot = p.to ? this.eng.tasks.lend(p.to, task.projectId) : null;
      if (cannot) return err(cannot);
    }
    const made: Task[] = [];
    for (const { spec, to } of plan) {
      made.push(
        this.eng.tasks.createTask(
          { projectId: task.projectId, title: truncate(spec.title, 200), description: truncate(spec.description, 12_000), acceptance: spec.acceptance ? truncate(String(spec.acceptance), 4000) : '', kind: (spec.kind as Task['kind']) ?? task.kind, priority: task.priority, assigneeId: to?.id ?? null, parentId: task.id, reviewBy: 'none', released: true },
          `employee:${employee.name}`,
        ),
      );
    }
    const lines = made.map((t) => `${t.key} "${truncate(t.title, 80)}" — ${this.core.employees.get(t.assigneeId)?.name ?? 'whoever is free'}`);
    this.add(task, { from: { kind: 'employee', id: employee.id, name: employee.name }, body: `Divided into ${made.length} part${made.length === 1 ? '' : 's'}:\n${lines.map((l) => `- ${l}`).join('\n')}`, kind: 'split', mentions: [] });
    this.core.event({ type: 'task.split', source: 'mcp', summary: `${employee.name} divided ${task.key} into ${made.length} part${made.length === 1 ? '' : 's'}`, taskId: task.id, projectId: task.projectId, employeeId: employee.id, data: { key: task.key, parts: made.map((t) => t.key) } });
    return {
      text: `${task.key} now has ${made.length === 1 ? 'this part' : 'these parts'}:\n${lines.join('\n')}\nEach is handed to its colleague when they are free. Go on with what you kept for yourself. You are told as each part is finished; when you call complete_task before they all are, ${task.key} waits for them and comes back to you to bring the whole together.`,
    };
  }

  /** `complete_task` on a task whose parts are not all done: it waits for them. Returns what its assignee is told. */
  waitForParts(task: Task, employee: Employee, summary: string): string {
    const open = this.partsOf(task).filter((p) => p.status !== 'DONE');
    task.status = 'BLOCKED';
    task.waitingFor = { kind: 'parts' };
    task.blockedReason = `Waiting for its parts: ${open.map((p) => `${p.key}${p.assigneeId ? ` (${this.core.employees.get(p.assigneeId)?.name ?? 'somebody'})` : ''}`).join(', ')}`;
    this.eng.tasks.note(task, task.blockedReason, `employee:${employee.name}`);
    if (summary.trim()) this.add(task, { from: { kind: 'employee', id: employee.id, name: employee.name }, body: `My own part is finished: ${summary.trim()}`, kind: 'note', mentions: [] }, { store: false, quiet: true });
    this.core.put('task', task);
    this.core.event({ type: 'task.blocked', source: 'mcp', summary: `${task.key} waits for its parts`, taskId: task.id, projectId: task.projectId, employeeId: employee.id, data: { key: task.key, reason: task.blockedReason, waiting: 'parts', quiet: true } });
    const session = this.core.runningSessionOf(employee.id);
    if (session) this.eng.sessions.setActivity(session, 'idle', null);
    return `${task.key} is not complete yet: ${open.length === 1 ? 'a part of it is' : `${open.length} of its parts are`} still open (${open.map((p) => `${p.key} [${p.status}]`).join(', ')}). It waits for ${open.length === 1 ? 'it' : 'them'} and comes back to you when ${open.length === 1 ? 'it is' : 'they are'} done, to bring the whole together and hand it in. You are free meanwhile.`;
  }

  /** A part is finished (or gone): said on the task it belongs to; the last one brings that task back to its lead. */
  partSettled(part: Task, how: 'done' | 'removed'): void {
    const parent = part.parentId ? this.core.tasks.get(part.parentId) : undefined;
    if (!parent || parent.status === 'DONE') return;
    const who = this.core.employees.get(part.assigneeId)?.name ?? 'somebody';
    if (how === 'done') this.add(parent, { from: { kind: 'office', id: null, name: 'The office' }, body: `${part.key} "${truncate(part.title, 80)}" is done (${who})${part.evidence.summary ? `: ${truncate(part.evidence.summary, 600)}` : '.'}`, kind: 'part_done', mentions: [] });
    const parts = this.partsOf(parent).filter((p) => p.id !== part.id || how === 'done');
    const open = parts.filter((p) => p.status !== 'DONE');
    const lead = this.core.employees.get(parent.assigneeId);
    const project = this.core.projects.get(parent.projectId);
    if (parent.status === 'BLOCKED' && parent.waitingFor?.kind === 'parts') {
      if (open.length) {
        parent.blockedReason = `Waiting for its parts: ${open.map((p) => `${p.key}${p.assigneeId ? ` (${this.core.employees.get(p.assigneeId)?.name ?? 'somebody'})` : ''}`).join(', ')}`;
        this.core.put('task', parent);
        return;
      }
      const done = parts.filter((p) => p.status === 'DONE');
      const merge = project && project.workspace !== 'in_place' && parent.branch ? ` The parts are merged into ${project.integrationBranch}: bring them into your branch first (git merge ${project.integrationBranch}).` : '';
      this.eng.tasks.unblock(parent.id, `${done.length ? `All parts of ${parent.key} are done:\n${done.map((p) => `- ${p.key} (${this.core.employees.get(p.assigneeId)?.name ?? 'somebody'}): ${truncate(p.evidence.summary ?? p.title, 300)}`).join('\n')}\n` : `${parent.key} has no open parts any more. `}${merge} Bring the whole together, check that it works as one, and call complete_task.`, 'office', undefined, { threaded: true, from: { kind: 'system', id: null, name: 'the office' } });
      return;
    }
    if (how === 'done' && parent.status === 'IN_PROGRESS' && lead && lead.id !== part.assigneeId) {
      this.tell(lead, parent, { kind: 'office', id: null, name: 'The office' }, `Part ${part.key} of ${parent.key} is done (${who})${part.evidence.summary ? `: ${truncate(part.evidence.summary, 600)}` : '.'}\n${open.length ? `Still open: ${open.map((p) => `${p.key} [${p.status}]`).join(', ')}.` : 'All parts are done now.'} Go on with ${parent.key}.`);
    }
  }
}

const WORDS: Record<TaskComment['kind'], string> = { note: 'commented on', question: 'asked on', answer: 'answered on', handed_in: 'handed in', approved: 'approved', sent_back: 'sent back', handoff: 'handed over', split: 'divided', part_done: 'on' };
const LABEL: Record<TaskComment['kind'], string> = { note: '', question: 'question', answer: 'answer', handed_in: 'handed in', approved: 'approved', sent_back: 'sent back', handoff: 'handed over', split: '', part_done: '' };
