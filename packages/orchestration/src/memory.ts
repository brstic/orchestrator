/**
 * The office's long memory: what was done, decided and learned, word for word, searchable by meaning.
 *
 * Growth keeps *rules* (lessons) and measures whether they help. This keeps the *record*: every finished task
 * with how it went, every answer the owner gave, every blocker and what resolved it, every lesson, every meeting's
 * decision, and what employees chose to write down. An employee asks it a question in plain words (`recall`)
 * and is given what bears on it; a task is handed over with what the office already knows about its subject.
 *
 * The memory itself is MemPalace (github.com/MemPalace/mempalace, MIT) — a separate program, on the machine the
 * office's server runs on. The office writes each record as a small Markdown file and has MemPalace file and
 * search them, through its command line: `mine` and `search`. Where MemPalace is not installed there is no long
 * memory and nothing else changes.
 *
 * Kept light on purpose (the owner's server is shared): one MemPalace process at a time, never two; every call has
 * a time limit; and anything here that fails or is slow is skipped — the office never waits for its memory.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Employee, Lesson, Meeting, Question, Task } from '@orchestrator/contracts';
import { nowIso, redactSecrets, truncate } from '@orchestrator/contracts';
import type { Engine } from './engine.ts';
import { slug } from './vault-detect.ts';

export interface MemoryOptions {
  /** The `mempalace` program. Null: there is no long memory here. */
  bin: string | null;
  /** Where the records, the palace and MemPalace's own settings live (inside the office's data folder). */
  dir: string | null;
}

export type MemoryRoom = 'tasks' | 'answers' | 'blockers' | 'lessons' | 'meetings' | 'notes';
const ROOMS: MemoryRoom[] = ['tasks', 'answers', 'blockers', 'lessons', 'meetings', 'notes'];

export interface MemoryHit {
  room: string;
  source: string;
  /** How close in meaning (cosine similarity, 0…1), as MemPalace reports it. */
  score: number;
  text: string;
}

export interface MemoryStatus {
  available: boolean;
  version: string | null;
  /** Records written so far. */
  filed: number;
  lastFiledAt: string | null;
  /** The last thing that went wrong, in words; null when the last call worked. */
  lastError: string | null;
}

const WING = 'office';
/** Below this, a result is about something else. (MemPalace's multilingual model puts a clear match above 0.5.) */
export const RELEVANT = 0.42;
const FILED_KV = 'memory.filed';
/** Which way of writing records the palace on disk was made with (2: every record passes through the vault's capture). */
const SCHEMA_KV = 'memory.schema';
const SCHEMA = 2;
const MAX_FILED = 20_000;

export class Memory {
  private eng: Engine;
  private bin: string | null;
  private dir: string | null;
  private version: string | null = null;
  private ready = false;
  private queue: Promise<unknown> = Promise.resolve();
  private filed: Set<string>;
  private lastFiledAt: string | null = null;
  private lastError: string | null = null;
  private mineTimer: NodeJS.Timeout | null = null;

  constructor(eng: Engine, opts: MemoryOptions) {
    this.eng = eng;
    this.bin = opts.bin;
    this.dir = opts.dir;
    this.filed = new Set(eng.core.store.kvGet<string[]>(FILED_KV, []));
  }

  status(): MemoryStatus {
    return { available: this.available(), version: this.version, filed: this.filed.size, lastFiledAt: this.lastFiledAt, lastError: this.lastError };
  }

  /** Installed, set up, and not switched off by the owner. */
  available(): boolean {
    return this.ready && this.eng.core.settings.longMemory !== false;
  }

  private get records(): string {
    return path.join(this.dir!, 'records');
  }

  // ─────────────────────────── the program ───────────────────────────

  /** One MemPalace process at a time, with a time limit; its output, or an error that says what happened. */
  private run(args: string[], timeoutMs: number): Promise<string> {
    const job = this.queue.then(
      () =>
        new Promise<string>((resolve, reject) => {
          const env = {
            ...process.env,
            MEMPALACE_DISABLE_UPDATE_CHECK: '1',
            MEMPALACE_CONFIG_DIR: path.join(this.dir!, 'config'),
            // Multilingual: the owner writes Serbian, the employees English.
            MEMPALACE_EMBEDDING_MODEL: process.env.MEMPALACE_EMBEDDING_MODEL ?? 'embeddinggemma',
            // A few threads and small batches: this machine has other work.
            MEMPALACE_EMBEDDING_THREADS: process.env.MEMPALACE_EMBEDDING_THREADS ?? '4',
            MEMPALACE_EMBEDDINGGEMMA_BATCH_SIZE: process.env.MEMPALACE_EMBEDDINGGEMMA_BATCH_SIZE ?? '4',
          };
          // (stdin closed: its `init` asks a question when it has someone to ask.)
          const child = spawn(this.bin!, ['--palace', path.join(this.dir!, 'palace'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => (out = (out + d).slice(-200_000)));
          child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`MemPalace did not finish "${args[0]}" within ${Math.round(timeoutMs / 1000)} s`));
          }, timeoutMs);
          child.on('error', (e) => {
            clearTimeout(timer);
            reject(new Error(`MemPalace could not be started: ${e.message}`));
          });
          child.on('exit', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(out);
            else reject(new Error(`MemPalace "${args[0]}" failed (${code}): ${truncate((err || out).trim().split('\n').pop() ?? '', 200)}`));
          });
        }),
    );
    // The queue goes on whatever happened to this job.
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** Find out whether MemPalace is here, and set up the palace the first time. Never throws. */
  async start(): Promise<void> {
    if (!this.bin || !this.dir) return;
    try {
      const v = await this.run(['--version'], 30_000);
      this.version = /(\d+\.\d+\.\d+)/.exec(v)?.[1] ?? v.trim().slice(0, 40);
      for (const room of ROOMS) fs.mkdirSync(path.join(this.records, room), { recursive: true, mode: 0o700 });
      // A folder per room, and MemPalace's own description of them, made once.
      if (!fs.existsSync(path.join(this.records, 'mempalace.yaml'))) {
        for (const room of ROOMS) {
          const keep = path.join(this.records, room, 'README.md');
          if (!fs.existsSync(keep)) fs.writeFileSync(keep, `# ${room}\n\n${ROOM_ABOUT[room]}\n`, { mode: 0o600 });
        }
        await this.run(['init', this.records, '--yes', '--no-llm', '--direct'], 120_000);
      }
      // Records written by the first version were not passed through the vault: they are thrown away once and written again.
      if (this.eng.core.store.kvGet<number>(SCHEMA_KV, 0) < SCHEMA && fs.existsSync(path.join(this.dir, 'palace'))) {
        this.eng.core.store.kvSet(SCHEMA_KV, SCHEMA);
        this.eng.core.log('info', 'long memory: records are written again (they now pass through the vault first)');
        for (const sub of ['records', 'palace']) fs.rmSync(path.join(this.dir, sub), { recursive: true, force: true });
        this.filed.clear();
        this.eng.core.store.kvSet(FILED_KV, []);
        return this.start();
      }
      this.eng.core.store.kvSet(SCHEMA_KV, SCHEMA);
      this.ready = true;
      this.eng.core.log('info', `long memory: MemPalace ${this.version} (${this.bin}); records in ${this.records}`);
      this.catchUp();
      if (this.filed.size) this.scheduleMine(5000);
    } catch (e) {
      this.lastError = (e as Error).message;
      this.eng.core.log('warn', `long memory is not available: ${this.lastError}`);
    }
  }

  /** What happened before the memory was there (or while it was switched off) is filed too: the office's record so far. */
  private catchUp(): void {
    if (!this.available()) return;
    const core = this.eng.core;
    const newest = <T extends { createdAt?: string }>(list: T[]) => [...list].sort((a, b) => ((b.createdAt ?? '') > (a.createdAt ?? '') ? 1 : -1)).slice(0, 1500);
    try {
      for (const t of newest(core.tasks.filter((x) => x.status === 'DONE'))) this.task(t);
      for (const q of newest(core.questions.filter((x) => x.kind === 'question' && !!x.answer))) this.answer(q);
      for (const l of newest(core.lessons.filter((x) => x.status === 'active'))) this.lesson(l);
      for (const m of newest(core.meetings.filter((x) => !!x.decisionDoc))) this.meeting(m);
    } catch (e) {
      core.log('warn', `long memory: catching up failed: ${(e as Error).message}`);
    }
  }

  /**
   * Start the memory over: what the office wrote and what MemPalace filed are deleted, and the office's record is
   * written and filed again. For when records were written that should not have been (an older version wrote a
   * password that stood in a task), or when what a record says was changed.
   */
  async rebuild(): Promise<MemoryStatus> {
    if (!this.bin || !this.dir) return this.status();
    if (this.mineTimer) clearTimeout(this.mineTimer);
    this.mineTimer = null;
    await this.queue;
    this.ready = false;
    for (const sub of ['records', 'palace']) fs.rmSync(path.join(this.dir, sub), { recursive: true, force: true });
    this.filed.clear();
    this.eng.core.store.kvSet(FILED_KV, []);
    this.lastFiledAt = null;
    await this.start();
    return this.status();
  }

  /** After the owner switched the memory back on: what happened meanwhile. (Cheap when nothing is new.) */
  caughtUp(): void {
    this.catchUp();
  }

  stop(): void {
    if (this.mineTimer) clearTimeout(this.mineTimer);
    this.mineTimer = null;
  }

  // ─────────────────────────── writing ───────────────────────────

  /** Write one record (once per `key`) and have it filed soon. Returns whether it was new. */
  remember(room: MemoryRoom, key: string, title: string, body: string): boolean {
    if (!this.available() || this.filed.has(key)) return false;
    // A credential in what is about to be remembered goes to the vault first: the record carries its name.
    const kept = this.eng.vault.capture(`# ${title.trim()}\n\n${body.trim()}\n`, { kind: 'office', id: null, name: 'The office' });
    const text = redactSecrets(kept.text);
    try {
      const file = path.join(this.records, room, `${slug(key, 80) || 'record'}.md`);
      fs.writeFileSync(file, truncate(text, 12_000), { mode: 0o600 });
    } catch (e) {
      this.lastError = `a record could not be written: ${(e as Error).message}`;
      return false;
    }
    this.filed.add(key);
    if (this.filed.size > MAX_FILED) this.filed.delete(this.filed.values().next().value!);
    this.eng.core.store.kvSet(FILED_KV, [...this.filed]);
    this.scheduleMine();
    return true;
  }

  /** File what was written since the last time: one run for everything that came in during the wait. */
  private scheduleMine(delayMs = this.eng.core.timings.memoryMineDelayMs ?? 20_000): void {
    if (this.mineTimer) return;
    this.mineTimer = setTimeout(() => {
      this.mineTimer = null;
      void this.run(['mine', this.records, '--wing', WING, '--agent', 'orchestrator', '--direct'], 10 * 60_000).then(
        () => {
          this.lastFiledAt = nowIso();
          this.lastError = null;
        },
        (e) => {
          this.lastError = (e as Error).message;
          this.eng.core.log('warn', `long memory: ${this.lastError}`);
        },
      );
    }, delayMs);
    this.mineTimer.unref?.();
  }

  /** Wait until what was written has been filed (for tests, and for a recall right after a note). */
  async settled(): Promise<void> {
    if (this.mineTimer) {
      clearTimeout(this.mineTimer);
      this.mineTimer = null;
      await this.run(['mine', this.records, '--wing', WING, '--agent', 'orchestrator', '--direct'], 10 * 60_000).then(
        () => void (this.lastFiledAt = nowIso()),
        (e) => void (this.lastError = (e as Error).message),
      );
    }
    await this.queue;
  }

  // ─────────────────────────── reading ───────────────────────────

  /** What the memory holds that bears on a question, best first. Empty when there is nothing, no memory, or no time. */
  async recall(query: string, opts: { results?: number; timeoutMs?: number; room?: MemoryRoom } = {}): Promise<MemoryHit[]> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!this.available() || q.length < 3) return [];
    const limit = opts.timeoutMs ?? 30_000;
    // The caller waits this long and no longer — also when other calls are ahead of this one in the queue.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<MemoryHit[]>((resolve) => {
      timer = setTimeout(() => resolve([]), limit);
      timer.unref?.();
    });
    // (A question that begins with a dash would be read by the program as one of its own options.)
    const found = this.run(['search', q.replace(/^[-\s]+/, '') || '?', '--wing', WING, '--results', String(opts.results ?? 5), ...(opts.room ? ['--room', opts.room] : [])], limit).then(
      (out) => {
        this.lastError = null;
        return parseSearch(out).filter((h) => h.source !== 'README.md');
      },
      (e) => {
        // Asked before anything was filed: MemPalace says "Run: mempalace mine". That is an empty memory, not a fault.
        if (!/mempalace mine/i.test((e as Error).message)) this.lastError = (e as Error).message;
        return [] as MemoryHit[];
      },
    );
    return Promise.race([found, late]).finally(() => clearTimeout(timer));
  }

  /** The same, as a block of text for a prompt or a tool's answer: only what is close enough in meaning. */
  async recallText(query: string, opts: { results?: number; timeoutMs?: number; chars?: number } = {}): Promise<string> {
    const hits = (await this.recall(query, opts)).filter((h) => h.score >= RELEVANT);
    return hits.map((h) => `• (${h.room}) ${truncate(h.text.replace(/\n{2,}/g, '\n').trim(), opts.chars ?? 700)}`).join('\n\n');
  }

  // ─────────────────────────── what the office files by itself ───────────────────────────

  /** Is this something that happened on a member's own computer? That stays theirs: it is not filed in the office's memory. */
  private personal(hostId: string | null | undefined): boolean {
    return !!this.eng.core.hosts.get(hostId ?? '')?.memberId;
  }

  private who(id: string | null | undefined): Employee | undefined {
    return this.eng.core.employees.get(id ?? '');
  }

  /** A finished task: what it was, who did it, how it went. */
  task(t: Task): void {
    if (t.status !== 'DONE' || t.kind === 'review') return;
    const project = this.eng.core.projects.get(t.projectId);
    if (!project || this.personal(project.hostId)) return;
    const by = this.who(t.assigneeId);
    const v = t.evidence.verification;
    const friction = [
      t.friction.failedVerifications ? `${t.friction.failedVerifications} failed verification${t.friction.failedVerifications === 1 ? '' : 's'}` : '',
      t.friction.reviewRejections ? `${t.friction.reviewRejections} review${t.friction.reviewRejections === 1 ? '' : 's'} sent back` : '',
      t.friction.mergeConflicts ? `${t.friction.mergeConflicts} merge conflict${t.friction.mergeConflicts === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    this.remember(
      'tasks',
      `task-${t.id}`,
      `${t.key} ${t.title} (${project.name}) — done by ${by?.name ?? 'someone'} on ${(t.completedAt ?? nowIso()).slice(0, 10)}`,
      [
        t.description.trim() ? `What was asked:\n${truncate(t.description.trim(), 2500)}` : '',
        t.acceptance.trim() ? `Acceptance criteria:\n${truncate(t.acceptance.trim(), 1200)}` : '',
        t.evidence.summary ? `What ${by?.name ?? 'the employee'} reported:\n${truncate(t.evidence.summary, 2500)}` : '',
        t.evidence.filesChanged.length ? `Files changed: ${t.evidence.filesChanged.slice(0, 30).join(', ')}` : '',
        v?.command ? `Verified by: ${v.command} — ${v.passed ? 'passed' : v.passed === false ? 'failed' : 'not run'}${v.touchedChecks?.length ? ` (the task changed its own checks: ${v.touchedChecks.join(', ')})` : ''}` : '',
        t.evidence.review ? `Review (${t.evidence.review.verdict.replace('_', ' ')} by ${this.who(t.evidence.review.reviewerId)?.name ?? 'the boss'}): ${truncate(t.evidence.review.comments, 1200)}` : '',
        friction.length ? `On the way: ${friction.join(', ')}.` : 'It went through without trouble.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  /** A question an employee asked and the answer it got (never a permission request: those are not knowledge). */
  answer(q: Question): void {
    if (q.kind !== 'question' || !q.answer || !['answered', 'delivered', 'confirmed'].includes(q.status)) return;
    const asker = this.who(q.employeeId);
    if (this.personal(asker?.hostId)) return;
    const project = this.eng.core.projects.get(q.projectId ?? '');
    const task = this.eng.core.tasks.get(q.taskId ?? '');
    this.remember(
      'answers',
      `answer-${q.id}`,
      `${q.answeredBy?.kind === 'foreman' ? `${q.answeredBy.name} (the foreman)` : 'The boss'} answered ${asker?.name ?? 'an employee'}${project ? ` (${project.name}${task ? `, ${task.key}` : ''})` : ''}: ${truncate(q.text, 120)}`,
      [`Question: ${q.text}`, q.context ? `Context: ${truncate(q.context, 1200)}` : '', q.why ? `Why it was asked: ${truncate(q.why, 600)}` : '', `Answer: ${q.answer}`, `Answered on ${(q.answeredAt ?? nowIso()).slice(0, 10)}.`].filter(Boolean).join('\n\n'),
    );
  }

  /** A blocker and what resolved it. */
  unblocked(t: Task, was: string | null, how: string, by: string): void {
    const project = this.eng.core.projects.get(t.projectId);
    if (!project || this.personal(project.hostId) || !how.trim()) return;
    this.remember('blockers', `blocker-${t.id}-${t.history.length}`, `${t.key} ${t.title} (${project.name}) was blocked, and how it was resolved`, [`Blocked on: ${was ?? 'not recorded'}`, `Resolved by ${by} on ${nowIso().slice(0, 10)}: ${how}`].join('\n\n'));
  }

  /** A lesson in use. */
  lesson(l: Lesson): void {
    if (l.status !== 'active') return;
    const owner = this.who(l.employeeId);
    if (this.personal(owner?.hostId) || this.personal(this.eng.core.projects.get(l.projectId ?? '')?.hostId)) return;
    const scope = l.scope === 'employee' ? `${owner?.name ?? 'an employee'}'s own` : l.scope === 'project' ? `for ${this.eng.core.projects.get(l.projectId ?? '')?.name ?? 'a project'}` : 'for the whole company';
    this.remember('lessons', `lesson-${l.id}`, `A lesson ${scope}: ${truncate(l.text, 120)}`, [l.text, l.appliesWhen ? `Applies when: ${l.appliesWhen}` : '', l.captureWhy ? `Why: ${l.captureWhy}` : '', `Learned on ${l.createdAt.slice(0, 10)} (${l.authoredBy.name}).`].filter(Boolean).join('\n\n'));
  }

  /** What a meeting decided. */
  meeting(m: Meeting): void {
    if (!m.decisionDoc || this.personal(this.eng.core.projects.get(m.projectId ?? '')?.hostId)) return;
    const people = m.participantIds.map((id) => this.who(id)?.name).filter(Boolean).join(', ');
    this.remember('meetings', `meeting-${m.id}`, `Meeting on ${(m.concludedAt ?? nowIso()).slice(0, 10)}: ${truncate(m.topic, 140)}`, [m.context ? `Context: ${truncate(m.context, 1500)}` : '', people ? `Present: ${people}` : '', `Decision:\n${truncate(m.decisionDoc, 6000)}`].filter(Boolean).join('\n\n'));
  }

  /** Something an employee chose to write down. */
  note(by: Employee, about: string, text: string): boolean {
    if (this.personal(by.hostId)) return false;
    const project = this.eng.core.projects.get(by.projectId ?? '');
    const key = `note-${by.id}-${Date.now().toString(36)}`;
    return this.remember('notes', key, `${by.name}'s note${project ? ` (${project.name})` : ''}, ${nowIso().slice(0, 10)}: ${truncate(about || text, 120)}`, text);
  }
}

const ROOM_ABOUT: Record<MemoryRoom, string> = {
  tasks: 'Finished tasks of this office: what was asked, what was done, how it was verified and reviewed, what went wrong on the way.',
  answers: 'Questions employees asked and the answers they were given.',
  blockers: 'What work was blocked on, and what resolved it.',
  lessons: 'Lessons the office and its employees learned and use.',
  meetings: 'What meetings decided.',
  notes: 'Notes employees wrote down for later: decisions and their reasons, how things here work, what was tried and dropped.',
};

/**
 * MemPalace's `search` output → results. It prints, per result:
 *
 *     [1] office / answers
 *         Source: q-rate-limit.md
 *         Match:  cosine_sim=0.68  bm25=3.546
 *
 *         …the text, indented…
 *
 *     --------------------------------------------------------
 */
export function parseSearch(out: string): MemoryHit[] {
  const hits: MemoryHit[] = [];
  const blocks = out.split(/^[ \t]*\[\d+\][ \t]+/m).slice(1);
  for (const block of blocks) {
    const lines = block.split('\n');
    const room = (lines[0] ?? '').split('/').pop()?.trim() ?? '';
    const source = /Source:\s*(.+)/.exec(block)?.[1]?.trim() ?? '';
    const score = Number(/cosine_sim=(-?[\d.]+)/.exec(block)?.[1] ?? 0);
    const start = lines.findIndex((l) => /^\s*Match:/.test(l));
    const body = lines
      .slice(start + 1)
      .join('\n')
      .split(/^[ \t]*-{20,}[ \t]*$/m)[0]!
      .split('\n')
      .map((l) => l.replace(/^ {6}/, '').trimEnd())
      .join('\n')
      .trim();
    if (body) hits.push({ room, source, score: Number.isFinite(score) ? score : 0, text: body });
  }
  return hits;
}
