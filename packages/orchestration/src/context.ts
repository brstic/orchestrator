/**
 * The central context (`docs/CONTEXT.md`): short facts in layers that every employee always holds — whoever they talk
 * to, rented or not, on whichever Claude account.
 *
 *   office   everyone (rented employees too, but for facts kept from clients)
 *   project  everyone working on that project (or building on it)
 *   role     everyone with that role
 *   client   the employees that client rents — given with that client's messages (rent.ts), not in the pack
 *   self     one employee: what they are in the middle of, their own notes
 *
 * For each employee the office compiles a **pack** (`packFor`) with a version, and sends it to the machine their session
 * runs on (`session.context`) whenever it changes; the machine's agent hands it to Claude Code itself — whole when a
 * session starts, is resumed or was compacted, and as the change at the next prompt. Facts beyond what is always held
 * are found with `get_context`; employees propose facts with `propose_context` — straight in for their own notes and
 * their project, through a person for the rest.
 */
import crypto from 'node:crypto';
import { CONTEXT_HARD_CAP_CHARS, newId, nowIso, roleByKey, truncate, type ContextFact, type ContextItem, type ContextLayer, type ContextPack, type Employee, type Lesson, type Meeting, type Question } from '@orchestrator/contracts';
import { EngineError } from './core.ts';
import type { Engine } from './engine.ts';

const KV = 'context.facts';
const HISTORY = 'context.history';
export const CONTEXT_LIMITS = { title: 80, text: 2000, facts: 2000, history: 2000 };
/** Layers an employee's proposal goes straight into (their own notes, their project's state); the rest wait for a person. */
export const CONTEXT_STRAIGHT_IN: ContextLayer[] = ['self', 'project'];

export interface ContextChange {
  id: string;
  factId: string;
  at: string;
  by: string;
  what: 'added' | 'changed' | 'archived' | 'proposed' | 'accepted' | 'dropped';
  title: string;
  layer: ContextLayer;
  scope: string | null;
  before?: string;
  after?: string;
}

/** An answer that sounds like it holds from now on — in English or in Serbian. */
/** A lesson kept from the boss's answer that holds for that once, not as a rule ("Deploy T-187 now?": "yes"). */
const oneOff = (l: Pick<Lesson, 'source' | 'text'>): boolean => l.source === 'owner_answer' && !STANDING.test(l.text.replace(/^Decided by the boss — "[\s\S]*?": /, ''));
const STANDING = /\b(always|never|from now on|every time|whenever|by default|in future|going forward|uvek|uvijek|nikad|nikada|od sada|ubudu[cć]e|svaki put|uvek kad|po defaultu|standardno)\b/i;

const clean = (s: unknown, max: number) => String(s ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

export class CentralContext {
  private eng: Engine;
  private facts = new Map<string, ContextFact>();
  /** The version each session's machine was last sent. */
  private sent = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(eng: Engine) {
    this.eng = eng;
    for (const f of eng.core.store.kvGet<ContextFact[]>(KV, [])) this.facts.set(f.id, f);
  }

  private get core() {
    return this.eng.core;
  }

  start(): void {
    this.healOneOffs();
    // What anybody holds can change with who works where, on what, for whom: looked at again when that changes.
    this.core.bus.on('entity', (kind, op, data) => {
      if (kind === 'session' && op === 'upsert' && (data as { status?: string }).status === 'running' && !this.sent.has((data as { id: string }).id)) this.later();
      else if ((kind === 'employee' || kind === 'project') && op === 'upsert') this.later();
      else if (kind === 'host' && op === 'upsert' && (data as { status?: string }).status === 'online') {
        // (Its agent may have been restarted or updated: it is told again.)
        for (const s of this.core.sessions.filter((x) => x.hostId === (data as { id: string }).id)) this.sent.delete(s.id);
        this.later();
      }
    });
    this.core.bus.on('event', (e) => {
      if (e.type === 'rent.changed') this.later();
    });
    // The office notices: a meeting's decision, a standing answer of the boss's, a lesson the office took in — each offered
    // for the context, once; never put in by itself.
    this.core.bus.on('entity', (kind, op, data) => {
      if (op !== 'upsert') return;
      if (kind === 'meeting') this.noticeMeeting(data as Meeting);
      else if (kind === 'question') this.noticeAnswer(data as Question);
      else if (kind === 'lesson') this.noticeLesson(data as Lesson);
    });
  }

  /**
   * Once: what the office took in before from the boss's one-off answers is put away (2026-11-27: 63 of the 70 facts
   * that came from lessons on the live office were "Decided by the boss — deploy T-187 now?: yes" and the like, given to
   * every employee of the project as a rule). The lessons stay, for their project (`learning/`); a yes to a release is
   * retired — it was for that release only.
   */
  private healOneOffs(): void {
    const MARK = 'context.healed.oneOffAnswers';
    if (this.core.store.kvGet<boolean>(MARK, false)) return;
    let put = 0;
    for (const l of this.core.lessons.filter((x) => x.source === 'owner_answer' && x.status === 'active' && x.evidence.some((e) => e.kind === 'question' && this.core.questions.get(e.id)?.kind === 'deployment'))) {
      this.core.put('lesson', { ...l, status: 'retired', updatedAt: nowIso() });
    }
    for (const f of [...this.facts.values()]) {
      const l = f.createdBy.startsWith('lesson:') ? this.core.lessons.get(f.createdBy.slice(7)) : undefined;
      if (!l || l.source !== 'owner_answer' || (l.status === 'active' && !oneOff(l))) continue;
      if (f.status === 'active') this.archive(f.id, 'office');
      else if (f.status === 'proposed') this.drop(f.id, 'office');
      else continue;
      put++;
    }
    this.core.store.kvSet(MARK, true);
    if (put) this.core.log('info', `context: ${put} facts made from the boss's one-off answers put away`);
  }

  private save(): void {
    this.core.store.kvSet(KV, [...this.facts.values()]);
  }

  private log(c: Omit<ContextChange, 'id' | 'at'>): void {
    const all = this.core.store.kvGet<ContextChange[]>(HISTORY, []);
    this.core.store.kvSet(HISTORY, [...all, { id: newId(), at: nowIso(), ...c }].slice(-CONTEXT_LIMITS.history));
  }

  history(): ContextChange[] {
    return this.core.store.kvGet<ContextChange[]>(HISTORY, []);
  }

  list(): ContextFact[] {
    return [...this.facts.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): ContextFact | undefined {
    return this.facts.get(id);
  }

  require(id: string): ContextFact {
    const f = this.facts.get(id);
    if (!f) throw new EngineError('no such fact', 404);
    return f;
  }

  // ───────────── writing facts ─────────────

  /** A layer and what it is about, checked: the thing must exist. */
  private scopeOf(layer: unknown, scope: unknown): { layer: ContextLayer; scope: string | null } {
    const l = String(layer ?? '') as ContextLayer;
    const s = scope == null || scope === '' ? null : String(scope);
    switch (l) {
      case 'office':
        return { layer: l, scope: null };
      case 'project':
        if (!s || !this.core.projects.get(s)) throw new EngineError('name the project the fact is about');
        return { layer: l, scope: s };
      case 'client':
        if (!s || !this.eng.rent.get(s)) throw new EngineError('name the client the fact is about');
        return { layer: l, scope: s };
      case 'role':
        if (!s || !roleByKey(s)) throw new EngineError('name the role the fact is about');
        return { layer: l, scope: s };
      case 'self':
        if (!s || !this.core.employees.get(s)) throw new EngineError('name the employee the fact is about');
        return { layer: l, scope: s };
      default:
        throw new EngineError('a fact is about the office, a project, a role, a client or one employee');
    }
  }

  /** The words of a fact, with any credential in them moved to the vault (as in a message). */
  private words(text: unknown, by: string): string {
    const t = clean(text, CONTEXT_LIMITS.text);
    if (!t) throw new EngineError('write the fact');
    return this.eng.vault.capture(t, { kind: 'owner', id: null, name: by.replace(/^member:/, '') }, []).text;
  }

  add(input: { layer?: unknown; scope?: unknown; title?: unknown; text?: unknown; always?: unknown; notForClients?: unknown; reviewBy?: unknown }, by: string, status: ContextFact['status'] = 'active'): ContextFact {
    if (this.facts.size >= CONTEXT_LIMITS.facts) throw new EngineError('the office keeps as many facts as it can: archive some first');
    const { layer, scope } = this.scopeOf(input.layer, input.scope);
    const title = clean(input.title, CONTEXT_LIMITS.title);
    if (!title) throw new EngineError('give the fact a title: a few words saying what it is');
    const now = nowIso();
    const fact: ContextFact = {
      id: newId(),
      layer,
      scope,
      title,
      text: this.words(input.text, by),
      always: input.always !== false,
      ...(layer === 'office' && input.notForClients === true ? { notForClients: true } : {}),
      reviewBy: typeof input.reviewBy === 'string' && input.reviewBy ? input.reviewBy.slice(0, 30) : null,
      status,
      createdAt: now,
      createdBy: by,
      updatedAt: now,
      updatedBy: by,
    };
    this.facts.set(fact.id, fact);
    this.save();
    this.log({ factId: fact.id, by, what: status === 'proposed' ? 'proposed' : 'added', title, layer, scope, after: fact.text });
    this.core.audit(by, status === 'proposed' ? 'context.proposed' : 'context.added', fact.id, { layer, scope, title });
    this.changed();
    return fact;
  }

  update(id: string, patch: { title?: unknown; text?: unknown; always?: unknown; notForClients?: unknown; reviewBy?: unknown }, by: string): ContextFact {
    const f = this.require(id);
    const before = f.text;
    if (patch.title !== undefined) {
      const t = clean(patch.title, CONTEXT_LIMITS.title);
      if (!t) throw new EngineError('a fact needs a title');
      f.title = t;
    }
    if (patch.text !== undefined) f.text = this.words(patch.text, by);
    if (typeof patch.always === 'boolean') f.always = patch.always;
    if (typeof patch.notForClients === 'boolean' && f.layer === 'office') f.notForClients = patch.notForClients || undefined;
    if (patch.reviewBy !== undefined) f.reviewBy = typeof patch.reviewBy === 'string' && patch.reviewBy ? patch.reviewBy.slice(0, 30) : null;
    f.updatedAt = nowIso();
    f.updatedBy = by;
    this.save();
    this.log({ factId: id, by, what: 'changed', title: f.title, layer: f.layer, scope: f.scope, before, after: f.text });
    this.core.audit(by, 'context.changed', id, { title: f.title });
    this.changed();
    return f;
  }

  archive(id: string, by: string): ContextFact {
    const f = this.require(id);
    f.status = 'archived';
    f.updatedAt = nowIso();
    f.updatedBy = by;
    this.save();
    this.log({ factId: id, by, what: 'archived', title: f.title, layer: f.layer, scope: f.scope, before: f.text });
    this.core.audit(by, 'context.archived', id, { title: f.title });
    this.changed();
    return f;
  }

  /** A proposal is taken in (as it is, or as a person edited it). */
  accept(id: string, by: string): ContextFact {
    const f = this.require(id);
    if (f.status !== 'proposed') throw new EngineError('that is not a proposal');
    f.status = 'active';
    f.updatedAt = nowIso();
    f.updatedBy = by;
    this.save();
    this.log({ factId: id, by, what: 'accepted', title: f.title, layer: f.layer, scope: f.scope, after: f.text });
    this.eng.comms.resolveNotifications((n) => n.kind === 'info' && n.title.startsWith('Proposed for the central context') && n.body.includes(f.title));
    this.changed();
    return f;
  }

  drop(id: string, by: string): void {
    const f = this.require(id);
    if (f.status !== 'proposed') throw new EngineError('that is not a proposal');
    this.facts.delete(id);
    this.save();
    this.log({ factId: id, by, what: 'dropped', title: f.title, layer: f.layer, scope: f.scope, before: f.text });
    this.eng.comms.resolveNotifications((n) => n.kind === 'info' && n.title.startsWith('Proposed for the central context') && n.body.includes(f.title));
  }

  /**
   * An employee proposes a fact. Their own notes and their project's state go straight in; the office's, a role's and a
   * client's wait for a person (in the Inbox and the Context window).
   */
  propose(employee: Employee, input: { layer?: unknown; title?: unknown; text?: unknown; project?: unknown }, clientId: string | null): ContextFact {
    const layer = String(input.layer ?? 'office') as ContextLayer;
    const scope =
      layer === 'self'
        ? employee.id
        : layer === 'project'
          ? (this.core.projects.find((p) => p.name.toLowerCase() === String(input.project ?? '').trim().toLowerCase())?.id ?? employee.projectId)
          : layer === 'role'
            ? employee.roleKey
            : layer === 'client'
              ? clientId
              : null;
    if (layer === 'client' && !scope) throw new EngineError('a fact about a client is proposed while answering that client');
    if (layer === 'project' && !scope) throw new EngineError('you are on no project: name one with "project"');
    const straight = CONTEXT_STRAIGHT_IN.includes(layer);
    const fact = this.add({ layer, scope, title: input.title, text: input.text, always: true }, `employee:${employee.name}`, straight ? 'active' : 'proposed');
    if (!straight) {
      this.eng.comms.notify({ kind: 'info', severity: 'info', title: `Proposed for the central context by ${employee.name}`, body: `${fact.title} — ${truncate(fact.text, 200)} (Context → Proposals)`, employeeId: employee.id });
    }
    return fact;
  }

  /** A meeting reached a decision: offered as a proposal for its project (or the office), once. */
  private noticeMeeting(m: Meeting): void {
    if (!m.decisionDoc || !m.concludedAt) return;
    const marker = `meeting:${m.id}`;
    if (this.list().some((f) => f.createdBy === marker)) return;
    // (A meeting about a member's own project is that member's: not offered to the office.)
    if (m.projectId && this.eng.hosts.memberOfHost(this.core.projects.get(m.projectId)?.hostId)) return;
    const decision = m.decisionDoc.replace(/^#+\s.*$/gm, '').replace(/\s+/g, ' ').trim();
    if (!decision) return;
    try {
      const fact = this.add({ layer: m.projectId && this.core.projects.get(m.projectId) ? 'project' : 'office', scope: m.projectId ?? null, title: truncate(`Decided: ${m.topic}`, CONTEXT_LIMITS.title), text: truncate(decision, 600) }, marker, 'proposed');
      this.eng.comms.notify({ kind: 'info', severity: 'info', title: 'Proposed for the central context by a meeting', body: `${fact.title} (Context → Proposals)` });
    } catch (e) {
      this.core.log('warn', `context: a meeting's decision was not offered: ${(e as Error).message}`);
    }
  }

  /** Offered already (by what it came from), or not. */
  private offered(marker: string): boolean {
    return this.list().some((f) => f.createdBy === marker) || this.history().some((h) => h.by === marker);
  }

  /** A proposal the office makes itself, once per thing it came from. */
  private offer(marker: string, input: { layer: ContextLayer; scope: string | null; title: string; text: string }, why: string, quiet = false): ContextFact | null {
    if (this.offered(marker)) return null;
    try {
      const fact = this.add({ ...input, title: truncate(input.title, CONTEXT_LIMITS.title), text: truncate(input.text, 900) }, marker, 'proposed');
      if (!quiet) this.eng.comms.notify({ kind: 'info', severity: 'info', title: `Proposed for the central context by ${why}`, body: `${fact.title} (Context → Proposals)` });
      return fact;
    } catch (e) {
      this.core.log('warn', `context: not offered (${marker}): ${(e as Error).message}`);
      return null;
    }
  }

  /** Is this project (or the asker's machine) a member's own: what is said there is that member's, not offered to the office. */
  private personal(projectId: string | null | undefined, employeeId?: string | null): boolean {
    return !!this.eng.hosts.memberOfHost(this.core.projects.get(projectId ?? '')?.hostId) || !!(employeeId && this.eng.hosts.memberOfHost(this.core.employees.get(employeeId)?.hostId));
  }

  /**
   * The boss answered a question with what sounds like a standing rule ("always…", "never…", "from now on…"): offered
   * for the asker's project (or the office). An answer for this once is not.
   */
  private noticeAnswer(q: Question): void {
    if (q.kind !== 'question' || !q.answer || !['answered', 'delivered', 'confirmed'].includes(q.status) || q.answeredBy?.kind === 'foreman') return;
    if (!STANDING.test(q.answer) || this.personal(q.projectId, q.employeeId)) return;
    const project = q.projectId && this.core.projects.get(q.projectId) ? q.projectId : null;
    this.offer(`answer:${q.id}`, { layer: project ? 'project' : 'office', scope: project, title: `The boss's word: ${q.text.replace(/\s+/g, ' ')}`, text: q.answer }, "the boss's answer");
  }

  /** A lesson for the whole office or a project, taken in: offered as a fact (it is a rule the office already follows). */
  private noticeLesson(l: Lesson, quiet = false): void {
    if (l.status !== 'active' || l.scope === 'employee' || oneOff(l)) return;
    if (l.scope === 'project' && (!l.projectId || this.personal(l.projectId))) return;
    this.offer(`lesson:${l.id}`, { layer: l.scope === 'project' ? 'project' : 'office', scope: l.scope === 'project' ? l.projectId : null, title: `Lesson: ${l.text.replace(/\s+/g, ' ')}`, text: `${l.text}${l.appliesWhen ? ` (${l.appliesWhen})` : ''}` }, 'a lesson', quiet);
  }

  /**
   * What the office already knows, offered once as proposals (the owner takes in what holds): each employee's standing
   * instructions as their own notes, each project's description, goals and docs, the office's and projects' active
   * lessons. Not what is on a member's own computer. Returns how many were offered.
   */
  importExisting(by: string): number {
    let n = 0;
    for (const e of this.core.employees.filter((x) => !x.archived && !!x.instructions.trim() && !this.personal(null, x.id))) {
      if (this.offer(`import:instructions:${e.id}`, { layer: 'self', scope: e.id, title: `${e.name}'s standing instructions`, text: e.instructions.trim() }, 'an import', true)) n++;
    }
    for (const p of this.core.projects.filter((x) => x.status !== 'archived' && !this.personal(x.id))) {
      const text = [p.description, p.goals ? `Goals: ${p.goals}` : '', p.docs ? `Notes: ${p.docs}` : ''].map((x) => x.trim()).filter(Boolean).join('\n');
      if (text && this.offer(`import:project:${p.id}`, { layer: 'project', scope: p.id, title: `About ${p.name}`, text }, 'an import', true)) n++;
    }
    for (const l of this.core.lessons.filter((x) => x.status === 'active' && x.scope !== 'employee')) {
      const before = this.facts.size;
      this.noticeLesson(l, true);
      if (this.facts.size > before) n++;
    }
    this.core.audit(by, 'context.imported', 'context', { offered: n });
    // (One line in the Inbox for all of them, not one each.)
    if (n) this.eng.comms.notify({ kind: 'info', severity: 'info', title: `${n} proposal${n === 1 ? '' : 's'} for the central context`, body: 'What the office already knew — standing instructions, projects, lessons — waits in Context → Proposals: take in what holds.' });
    return n;
  }

  // ───────────── what an employee holds ─────────────

  /** The facts that apply to this employee (active ones), whatever their place: always held or on demand. */
  private theirs(e: Employee): ContextFact[] {
    const rented = this.eng.rent.isRented(e.id);
    const projects = new Set([e.projectId, ...(e.alsoProjectIds ?? [])].filter((p): p is string => !!p));
    return this.list().filter((f) => {
      if (f.status !== 'active') return false;
      switch (f.layer) {
        case 'office':
          return !(rented && f.notForClients);
        case 'project':
          return !!f.scope && projects.has(f.scope);
        case 'role':
          return f.scope === e.roleKey;
        case 'self':
          return f.scope === e.id;
        case 'client':
          // (Given with that client's message — rent.ts — not in the pack: one employee may answer several clients.)
          return false;
      }
    });
  }

  /** A client's facts, for that client's messages to an employee they rent. */
  clientFacts(clientId: string): ContextFact[] {
    return this.list().filter((f) => f.status === 'active' && f.layer === 'client' && f.scope === clientId);
  }

  private sectionOf(f: ContextFact, e: Employee): string {
    switch (f.layer) {
      case 'office':
        return 'The office';
      case 'project':
        return `Project ${this.core.projects.get(f.scope ?? '')?.name ?? ''}${f.scope && f.scope !== e.projectId ? ' (you build on it)' : ''}`.trim();
      case 'role':
        return `Your role: ${roleByKey(f.scope ?? '')?.title ?? f.scope}`;
      case 'self':
        return 'Your own notes';
      case 'client':
        return `Client ${this.eng.rent.get(f.scope ?? '')?.name ?? ''}`.trim();
    }
  }

  /** What the office knows by itself, never typed: who is here and on what, and the projects. */
  private derived(e: Employee): ContextItem[] {
    const team = this.core.employees
      .filter((x) => !x.archived && x.id !== e.id && this.eng.rent.reaches(e, x))
      .slice(0, 40)
      .map((x) => `${x.name} (${x.title}${x.projectId ? `, ${this.core.projects.get(x.projectId)?.name ?? ''}` : ''})`);
    const projects = this.core.projects.filter((p) => p.status !== 'archived' && (!this.eng.hosts.memberOfHost(p.hostId) || this.eng.hosts.memberOfHost(p.hostId) === this.eng.hosts.memberOfHost(e.hostId))).slice(0, 30).map((p) => p.name);
    const out: ContextItem[] = [];
    if (team.length) out.push({ id: 'derived:team', layer: 'office', section: 'The office', title: 'The team you can reach', text: team.join('; ') });
    if (projects.length) out.push({ id: 'derived:projects', layer: 'office', section: 'The office', title: 'Projects', text: projects.join(', ') });
    return out;
  }

  /** The pack this employee holds now: their facts in order, within the hard cap, and its version. */
  packFor(e: Employee): ContextPack {
    const order: ContextLayer[] = ['office', 'project', 'role', 'self'];
    const facts = this.theirs(e);
    const always = facts.filter((f) => f.always).sort((a, b) => order.indexOf(a.layer) - order.indexOf(b.layer) || a.createdAt.localeCompare(b.createdAt));
    const items: ContextItem[] = [...this.derived(e)];
    let size = items.reduce((n, i) => n + i.title.length + i.text.length + 10, 0);
    let over = 0;
    for (const f of always) {
      const n = f.title.length + f.text.length + 10;
      if (size + n > CONTEXT_HARD_CAP_CHARS) {
        over++;
        continue;
      }
      size += n;
      items.push({ id: f.id, layer: f.layer, section: this.sectionOf(f, e), title: f.title, text: f.text });
    }
    // The office's own words first, then the team as the office sees it, then the rest by layer.
    items.sort((a, b) => order.indexOf(a.layer) - order.indexOf(b.layer));
    const rev = crypto.createHash('sha1').update(JSON.stringify(items)).digest('hex').slice(0, 8);
    return { rev, items, onDemand: facts.length - always.length + over };
  }

  /** What an employee finds on demand: their facts (held or not) whose words match. Empty topic: the titles of the on-demand ones. */
  find(e: Employee, topic: string): string {
    const facts = this.theirs(e);
    const words = topic.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const hit = words.length ? facts.filter((f) => words.some((w) => `${f.title} ${f.text}`.toLowerCase().includes(w))) : facts.filter((f) => !f.always);
    if (!hit.length) return words.length ? `Nothing in the central context about "${topic}". Try recall (the long memory), or ask.` : 'Everything in the central context for you is already in front of you.';
    return hit
      .slice(0, 20)
      .map((f) => `## ${f.title} (${this.sectionOf(f, e)})\n${f.text}`)
      .join('\n\n');
  }

  // ───────────── getting it to the machines ─────────────

  /** Something changed: every running session is looked at again, a moment later (several changes go as one). */
  changed(): void {
    this.later();
  }

  private later(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pushAll();
    }, 250);
    this.timer.unref?.();
  }

  /**
   * Sessions whose machine's agent is older than the central context (it answers "unsupported rpc method"): not asked
   * again while they run. Before, a failed push was forgotten and tried at the next change — on the live office some
   * 60 000 times a day for one member's computer with an older app, each a warning in the log.
   */
  private unable = new Set<string>();

  /** Send each running session's pack to its machine when it differs from what was sent. */
  pushAll(): void {
    const running = this.core.sessions.filter((x) => x.status === 'running' || x.status === 'starting');
    for (const id of this.unable) if (!running.some((s) => s.id === id)) this.unable.delete(id);
    for (const s of running) {
      const e = s.employeeId ? this.core.employees.get(s.employeeId) : undefined;
      if (!e || this.unable.has(s.id) || !this.core.agents.isOnline(s.hostId)) continue;
      const pack = this.packFor(e);
      if (this.sent.get(s.id) === pack.rev) continue;
      this.sent.set(s.id, pack.rev);
      void this.core.agents.rpc(s.hostId, { method: 'session.context', params: { sessionId: s.id, context: pack } }, 8000).catch((err) => {
        const message = (err as Error).message;
        if (/unsupported rpc method/.test(message)) {
          this.unable.add(s.id);
          this.core.log('warn', `the central context does not reach ${e.name}'s session: their machine runs an older app (it gets the central context once it is updated)`);
          return;
        }
        this.sent.delete(s.id);
        this.core.log('warn', `the central context did not reach ${e.name}'s machine: ${message}`);
      });
    }
  }

  /** At a start: the pack goes with the launch, and counts as sent. */
  forLaunch(e: Employee, sessionId: string): ContextPack {
    const pack = this.packFor(e);
    this.sent.set(sessionId, pack.rev);
    return pack;
  }
}
