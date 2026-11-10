import type { CaptureOrigin, Employee, EvidenceRef, Lesson, MeasuredSkill, Message, Project, Question, Task } from '@orchestrator/contracts';
import { correlationMarker, redactSecrets, truncate } from '@orchestrator/contracts';
import { EngineError } from '../core.ts';
import type { Engine } from '../engine.ts';

/**
 * Capture: nothing the office could have learned from is lost.
 *
 * One step here costs a Claude turn — the retrospective, which already existed and is sent no more
 * often than before. Everything else reads what the office recorded anyway:
 *
 *   retrospectives    the facts in a structured form, a lesson in a fixed shape, no asking twice
 *   corrections       a message that reads as a standing rule becomes a lesson candidate
 *   rejections        the owner's review comments and denial notes become candidates
 *   repeats           a question asked again is shown with its earlier answer (never answered here)
 *   failures          the same verification failure on two tasks becomes project knowledge
 *   onboarding        a digest of the project's knowledge with an employee's first task there
 *   skills            what an employee's finished work shows, counted
 *
 * Everything in the first half of this file is a pure function of text: a word-overlap or pattern
 * heuristic, and named as one wherever its result is shown. Candidates are saved through the
 * Improver's own save path, so whatever merges or ranks lessons sees them like any other.
 */

// ───────────────────────────── text ──────────────────────────────

const STOP = new Set(
  'the a an to of in on for and or is are it its this that be been with as at by from we you i do does did should can could would will what which how if so my your our me us have has had was were not no yes please there here when then than but about into any all some they them their he she his her also just very too more most'.split(' ').concat(["don't", 'dont', "doesn't", "didn't", "can't", 'cannot', "won't", "isn't", "aren't", "it's", "i'm", "i've", "i'll", "we're", "you're", "that's"]),
);

/** Words of a text that carry meaning, lower-cased: identifiers and file names stay whole. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().replace(/’/g, "'").matchAll(/[\p{L}\p{N}_][\p{L}\p{N}_./'-]*/gu)) {
    const w = m[0].replace(/[./'-]+$/, '');
    if (w.length > 1 && !STOP.has(w)) out.push(w);
  }
  return out;
}

/** Shared words over all words: 1 = the same set, 0 = nothing in common. */
export function overlap(a: string[], b: string[]): number {
  const x = new Set(a);
  const y = new Set(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Test and automation directives are not part of what anybody said. */
const spoken = (text: string): string => redactSecrets(text.replace(/@@[\s\S]*?@@/g, ' ').replace(/```[\s\S]*?```/g, ' ')).trim();

// ──────────────────────── the shape of a lesson ───────────────────

export interface LessonArgs {
  lesson?: string;
  applies_when?: string;
  why?: string;
  scope?: string;
  none?: boolean;
  reason?: string;
  replaces?: string;
}

export type LessonCheck =
  | { ok: true; none: true; reason: string }
  | { ok: true; none: false; rule: string; when: string; why: string; scope: Lesson['scope'] }
  | { ok: false; field: 'lesson' | 'applies_when' | 'why' | 'reason'; message: string };

/** Words that say "do better" without saying what to do. */
const VAGUE = new Set(
  'be being careful carefully care attention attentive pay paying thorough thoroughly diligent mindful sure ensure make making always never try trying harder better good best well properly correctly right things thing everything anything stuff work working code coding mistakes mistake errors error problems problem issues issue check checking checks double doublecheck double-check triple quality think thinking twice again avoid future time next really much extra detail details focus focused slow slowly down fewer less improve improved improving'.split(' '),
);

/** Words that make a trigger apply to everything, which is the same as to nothing. */
const ANYTIME = new Set(
  'always anytime every everything everywhere time times general generally whenever wherever possible working work coding code doing things stuff task tasks future usually often sometimes relevant needed necessary appropriate applicable situation situations case cases needs arises comes up'.split(' '),
);

const SHAPE = 'A lesson has four parts: lesson (the rule, as an instruction), applies_when (the concrete trigger), why (the evidence) and scope (self, project or company).';

/**
 * Is this a lesson somebody could act on later? Checked at the tool boundary, so a vague one is
 * sent back with what is missing instead of being stored and repeated into every future prompt.
 */
export function checkLesson(args: LessonArgs): LessonCheck {
  if (args.none) {
    const reason = (args.reason ?? args.why ?? '').trim().replace(/\s+/g, ' ');
    if (reason.split(' ').length < 3) return { ok: false, field: 'reason', message: 'Say why there is nothing to learn: call record_lesson with none=true and reason="…" in one sentence (for example "the failure was a typo I caught on the second run; no rule would have prevented it").' };
    return { ok: true, none: true, reason: truncate(reason, 300) };
  }
  const rule = (args.lesson ?? '').trim().replace(/\s+/g, ' ');
  const when = (args.applies_when ?? '').trim().replace(/\s+/g, ' ').replace(/[.]+$/, '');
  const why = (args.why ?? '').trim().replace(/\s+/g, ' ');
  if (!rule) return { ok: false, field: 'lesson', message: `Provide the lesson, or none=true with a reason. ${SHAPE}` };
  const concrete = tokens(rule).filter((w) => !VAGUE.has(w));
  if (rule.split(' ').length < 4 || concrete.length < 2) {
    return {
      ok: false,
      field: 'lesson',
      message: `"${truncate(rule, 80)}" is too vague to reuse: it does not say what to do. Write the rule as an instruction you could follow next time, naming the action and what it is done to (a command, a kind of file, a step) — for example "Run the project's verification command before calling complete_task, not only the test file I changed". If nothing that concrete was learned, call record_lesson with none=true and a reason.`,
    };
  }
  if (!tokens(when).some((w) => !ANYTIME.has(w))) {
    return {
      ok: false,
      field: 'applies_when',
      message: `${when ? `applies_when "${truncate(when, 60)}" applies to everything, so it would be ignored` : 'applies_when is missing'}. Give the concrete trigger: a kind of file, a kind of task, a tool or a moment — for example "when editing *.sql migrations", "on bug tasks that touch the API" or "before calling complete_task".`,
    };
  }
  if (why.split(' ').length < 4) {
    return { ok: false, field: 'why', message: `why is ${why ? 'too short' : 'missing'}: say in one sentence what happened that taught you this — the evidence — for example "verification failed twice on this task because I ran only the test file I changed".` };
  }
  const scope = /^(company|office|everyone)$/i.test(args.scope ?? '') ? 'company' : /^(project|team)$/i.test(args.scope ?? '') ? 'project' : 'employee';
  return { ok: true, none: false, rule: truncate(rule, 400), when: truncate(when, 160), why: truncate(why, 300), scope };
}

// ─────────────────────────── corrections ─────────────────────────

export interface Correction {
  /** The sentence(s) that state the rule, in the speaker's words. */
  rule: string;
  /** Phrased for everybody ("we use…", "in this project…") rather than for the person addressed. */
  general: boolean;
  /** The wording that made it count. */
  matched: string;
}

/** Ways of saying "you" before the rule itself: "I want you to always…", "make sure you never…". */
const TO_YOU = "(?:(?:i (?:want|need|expect) you to|i'd like you to|i would like you to|you (?:need|have) to|you should|you must|make sure (?:that )?you|make sure to|remember to|be sure to) )?";
/** Things done to code and repositories: what a house rule is about. */
const PRACTICE = '(?:use|commit|push|merge|write|add|mock|test|deploy|touch|edit|change|allow|want|ship|put|keep|store|run|import|export|rely|depend|name|format|log|squash|rebase|install|upgrade|review|document|hard-?code|skip)';
/** "…for good": said once, meant from here on. Safe wherever it stands in the sentence. */
const STANDING = /\b(from now on|from here on|going forward|never again|ever again)\b|^(next time)\b|\b(next time)[.!]?$/i;
/** The same in a few other languages, only the phrases that cannot mean anything else. */
const STANDING_ELSEWHERE = /(?:^|[\s,;:(])(od sada|od sad|odsad|ubuduće|ubuduce|sledeći put|sledeci put|sljedeći put|ab jetzt|ab sofort|von nun an|a partir de ahora|de ahora en adelante|désormais|dorénavant|à partir de maintenant)(?=$|[\s,;:.!)])/i;
/** A sentence that opens as a rule — and not as a remark ("never seen this", "always fails on CI"). */
const OPENS_AS_RULE = new RegExp(`^${TO_YOU}(always|never)\\b(?! (?:mind|seen|saw|heard|had|been|was|were|is|has|thought|knew|happened|happens|got|did|worked|works|fails|failed|failing|breaks|broke|broken|the same|a)\\b)`, 'i');
const OPENS_AS_RULE_ELSEWHERE = /^(nemoj nikad|nemoj nikada|nemoj više|nemoj vise)(?=\s)/i;
/** A sentence about how things are done here: for everybody. */
const HOUSE_RULE = new RegExp(`^(?:(?:in|on|for) this (?:project|repo|repository|codebase)[, ]+)?(we (?:always|never|only|don'?t|do not) ${PRACTICE}\\b|we prefer\\b|we use (?:\\S+ ){1,5}?(?:not|instead of|rather than) |our convention\\b|the convention (?:here )?is\\b|(?:everyone|everybody|nobody|no one|the team) (?:must|should|has to)\\b)`, 'i');
const HOUSE_RULE_ELSEWHERE = /^(ne koristimo|koristimo\s.+\s(?:a ne|umesto|umjesto)\s)/i;
/** A sentence that tells the person addressed not to. */
const DIRECTIVE = /^(?:do not|don'?t|do n't|you (?:should not|shouldn'?t|must not|mustn'?t)|avoid|no more|stop (?:using|adding|writing|putting|committing|creating|making|asking|leaving|pushing|changing|touching|editing|mocking|skipping|ignoring|removing|deleting|renaming|reformatting|formatting|installing|importing|hard-?coding|guessing|assuming))(?=\s)/i;
/** …or to do it another way: "use X, not Y", "prefer X over Y". */
const SWAP = /^(?:use (?:\S+ ){1,4}?(?:not|instead of|rather than) |prefer (?:\S+ ){1,4}?over )/i;
/** …but not these, which are reassurance or a one-off reminder. */
const NOT_A_RULE = /^(?:do not|don'?t) (?:forget|worry|bother|mind|panic|hesitate|be afraid|stop|wait|rush)\b/i;
/** A directive tied to the moment or to the thing in front of us is an instruction for this task, not a rule. */
const ONE_OFF = /\b(this time|for now|right now|just|now|yet|today|tonight|tomorrow|until|till|for the moment|at the moment|this|that|these|those|it|them|here|there)\b/i;
/** Somebody talking about themselves is not giving a rule. */
const ABOUT_ME = /^(?!i (?:want|need|expect) you to|i'd like you to|i would like you to)(?:i|i'll|i'm|i've|i'd|we'll|we're|we've|let me|let's)\b/i;
/** Openers that are not part of the rule. */
const LEAD_IN = /^(?:(?:(?:ok(?:ay)?|hey|hi|hello|also|and|but|so|btw|please note|please|pls|note|reminder|one more thing|again|listen|look|important|fyi|thanks|good|nice)\b[\s,:.!–—-]*)|(?:(?:no|remember)[,:.!]\s*))+/i;
/** "Alex, never…" — a name in front is an address, not part of the rule. */
const ADDRESS = /^(?!always|never|stop|avoid|use|prefer|ubuduće|ubuduce|odsad|désormais|dorénavant)\p{Lu}\p{L}{1,20},\s+/iu;

function sentences(text: string): string[] {
  return spoken(text)
    .replace(/[’‘]/g, "'")
    .slice(0, 1500)
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Does a message read as a correction or a standing preference, rather than as an instruction for
 * the task at hand? Conservative on purpose: a missed correction costs nothing new (the owner says
 * it again), a task instruction mistaken for a rule would follow the employee into every prompt.
 * It matches wording — it does not understand the message.
 */
export function detectCorrection(text: string): Correction | null {
  const hits: Array<{ sentence: string; general: boolean; matched: string }> = [];
  for (const raw of sentences(text)) {
    if (/\?\s*$/.test(raw)) continue;
    const s = raw.replace(LEAD_IN, '').replace(ADDRESS, '').replace(LEAD_IN, '').trim();
    if (s.split(/\s+/).length < 2 || s.length < 10) continue;
    const house = HOUSE_RULE.exec(s) ?? HOUSE_RULE_ELSEWHERE.exec(s);
    const standing = ABOUT_ME.test(s) ? null : (STANDING.exec(s) ?? STANDING_ELSEWHERE.exec(s) ?? OPENS_AS_RULE.exec(s) ?? OPENS_AS_RULE_ELSEWHERE.exec(s));
    const swap = SWAP.exec(s);
    const directive = NOT_A_RULE.test(s) ? null : (DIRECTIVE.exec(s) ?? swap);
    const m = house ?? standing ?? directive;
    if (!m) continue;
    const marker = (m[1] ?? m[2] ?? m[3] ?? m[0]).trim().toLowerCase();
    // Something has to be left to follow once the trigger words are taken away.
    const rest = tokens(m === swap ? s.replace(/^\S+/, ' ') : s.replace(m[0], ' '));
    if (!rest.length) continue;
    if (!house && !standing && (ONE_OFF.test(s) || rest.length < 2)) continue;
    hits.push({ sentence: s, general: !!house || /\b(everyone|everybody|nobody|no one|all of you|the whole team)\b/i.test(s), matched: marker });
    if (hits.length === 2) break;
  }
  if (!hits.length) return null;
  const rule = hits.map((h) => h.sentence.replace(/^./, (c) => c.toUpperCase())).join(' ');
  return { rule: truncate(rule, 300), general: hits.some((h) => h.general), matched: hits.map((h) => h.matched).join(', ') };
}

// ──────────────────────────── failures ───────────────────────────

const FAILURE_LINE = /error|fail|assert|exception|expected|not ok|cannot|can't|unable|undefined|unexpected|denied|missing|timed out|timeout|panic|traceback|refused|not found|no such|invalid|✖|✗|×/i;

/** One line of output with everything that differs between two runs of the same failure taken out. */
export function normaliseLine(line: string): string {
  return line
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/(?<![\w.@~+-])(?:[A-Za-z]:\\|~\/|\.{1,2}\/|\/)?(?:[\w.@~+-]+[/\\])+([\w.@~+-]+)/g, '<path>/$1')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/\d+(?:[.,:]\d+)*(?:\s?(?:ms|s|sec|min|kb|mb|gb)\b|%)?/gi, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface FailureSignature {
  command: string;
  /** The lines that say what failed, normalised. */
  lines: string[];
  /** The first of them as it was printed, for people. */
  headline: string;
}

/** What a failed verification looks like once paths, numbers, ids and timings are ignored. */
export function failureSignature(command: string, output: string): FailureSignature {
  const raw = output.split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()).filter(Boolean);
  const telling = raw.filter((l) => FAILURE_LINE.test(l));
  const picked = (telling.length ? telling : raw.slice(-4)).slice(0, 6);
  return { command: command.trim().replace(/\s+/g, ' '), lines: [...new Set(picked.map(normaliseLine))], headline: truncate(redactSecrets(picked[0] ?? ''), 140) };
}

/** The same command failing with nearly the same words. A measure of overlap, not of cause. */
export function sameFailure(a: FailureSignature, b: FailureSignature, threshold = 0.6): boolean {
  if (a.command !== b.command || !a.lines.length || !b.lines.length) return false;
  return overlap(tokens(a.lines.join(' ')), tokens(b.lines.join(' '))) >= threshold;
}

const sigOf = (kind: string, key: string): string => `${kind}|${key}`;

/** Are two recorded frictions the same thing happening again? Compared by kind, then by their words. */
export function sameFriction(a: string, b: string): boolean {
  const [ka, ...ra] = a.split('|');
  const [kb, ...rb] = b.split('|');
  if (ka !== kb) return false;
  const x = ra.join('|');
  const y = rb.join('|');
  if (ka === 'nudge') return true;
  if (ka === 'denial') return x === y;
  if (ka === 'conflict') return x.split(',').some((f) => !!f && y.split(',').includes(f));
  if (ka === 'verify') {
    const [ca, ...la] = x.split('\n');
    const [cb, ...lb] = y.split('\n');
    return ca === cb && overlap(tokens(la.join(' ')), tokens(lb.join(' '))) >= 0.6;
  }
  return overlap(tokens(x), tokens(y)) >= 0.5;
}

// ───────────────────────────── repeats ───────────────────────────

/** How alike two questions read, by the words they share (0…1). */
export function questionSimilarity(a: string, b: string): number {
  const x = tokens(spoken(a));
  const y = tokens(spoken(b));
  if (x.length < 2 || y.length < 2) return spoken(a).toLowerCase().replace(/\W+/g, ' ').trim() === spoken(b).toLowerCase().replace(/\W+/g, ' ').trim() ? 1 : 0;
  return overlap(x, y);
}

/** At or above this, a new question is shown with the earlier answer. */
export const REPEAT_THRESHOLD = 0.6;
/** How much of a first task prompt the onboarding digest may take, in characters. */
export const ONBOARDING_BUDGET = 1200;

// ───────────────────────────── the facts ─────────────────────────

export interface RetroFact {
  kind: 'attempts' | 'verification' | 'review' | 'merge' | 'blocked' | 'question' | 'denial' | 'nudge' | 'told';
  text: string;
  /** Comparable form of the friction, when this fact is one. */
  signature: string | null;
}

/** The last lines of an output, cut at a line boundary. */
function tail(output: string, max: number): string {
  const s = output.replace(/\s+$/, '');
  if (s.length <= max) return s;
  const cut = s.slice(-max);
  const nl = cut.indexOf('\n');
  return `…${nl >= 0 && nl < max / 3 ? cut.slice(nl) : cut}`;
}

const indent = (text: string): string => text.split('\n').map((l) => `    ${l}`).join('\n');
const times = (n: number): string => `${n} time${n === 1 ? '' : 's'}`;

export class Capture {
  private eng: Engine;
  /** The retrospective each employee is answering: what a lesson recorded now is about. */
  private asked = new Map<string, { taskId: string; signatures: string[]; revises: string | null }>();

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  private get on(): boolean {
    return this.core.settings.selfImprovement.enabled;
  }

  /** Every automatic step is on the record, with what it was based on and how to take it back. */
  private note(verb: string, summary: string, at: { employeeId?: string | null; taskId?: string | null; projectId?: string | null }, data: { what: string; why: string; evidence: EvidenceRef[]; undo: Record<string, unknown> | null; quiet?: boolean; [k: string]: unknown }): void {
    this.core.event({ type: `learning.${verb}`, source: 'server', summary, employeeId: at.employeeId ?? null, taskId: at.taskId ?? null, projectId: at.projectId ?? null, data: { auto: true, area: 'capture', ...data } });
  }

  /** Never let a learning step break the work it is watching. */
  private safely<T>(what: string, fn: () => T, otherwise: T): T {
    try {
      return fn();
    } catch (e) {
      this.core.log('warn', `capture (${what}) failed: ${(e as Error).message}`);
      return otherwise;
    }
  }

  // ───────────────────────── retrospectives ────────────────────────

  /** What the record says happened on a task, in the order it matters to its author. */
  facts(task: Task): RetroFact[] {
    const facts: RetroFact[] = [];
    const events = this.core.store.queryEvents({ taskId: task.id, types: ['task.verification_failed', 'task.review_completed', 'task.merge_conflict', 'task.blocked', 'task.unblocked'], limit: 300 });
    const name = (id: string | null | undefined) => this.core.employees.get(id)?.name;
    const f = task.friction;
    if (task.attempts > 0) {
      const parts = [f.failedVerifications ? `${f.failedVerifications} failed verification${f.failedVerifications === 1 ? '' : 's'}` : '', f.reviewRejections ? `${f.reviewRejections} review rejection${f.reviewRejections === 1 ? '' : 's'}` : '', f.mergeConflicts ? `${f.mergeConflicts} merge conflict${f.mergeConflicts === 1 ? '' : 's'}` : ''].filter(Boolean);
      facts.push({ kind: 'attempts', text: `It took ${task.attempts + 1} attempts: ${times(task.attempts)} your completed work was sent back${parts.length ? ` (${parts.join(', ')})` : ''}.`, signature: null });
    }

    // Each distinct way verification failed, with how often and the exact end of its output.
    const groups: Array<{ sig: FailureSignature; count: number; last: (typeof events)[number] }> = [];
    for (const e of events.filter((x) => x.type === 'task.verification_failed')) {
      const sig = failureSignature(String(e.data.command ?? ''), String(e.data.outputTail ?? ''));
      const g = groups.find((x) => sameFailure(x.sig, sig, 0.8));
      if (g) {
        g.count++;
        g.last = e;
      } else groups.push({ sig, count: 1, last: e });
    }
    for (const g of groups.slice(-3)) {
      const how = g.last.data.timedOut ? 'timed out' : `exit code ${g.last.data.exitCode ?? '?'}`;
      facts.push({
        kind: 'verification',
        text: `Verification ("${g.sig.command}") failed ${times(g.count)} before it passed (${how}). The end of its output, exactly:\n${indent(tail(String(g.last.data.outputTail ?? ''), 900) || '(no output)')}`,
        signature: g.last.data.timedOut ? sigOf('verify', `${g.sig.command}\ntimed out`) : sigOf('verify', `${g.sig.command}\n${g.sig.lines.join('\n')}`),
      });
    }
    for (const e of events.filter((x) => x.type === 'task.review_completed' && x.data.verdict === 'changes_requested')) {
      const who = e.data.reviewerId ? (name(String(e.data.reviewerId)) ?? 'a reviewer') : 'the boss';
      const comments = String(e.data.comments ?? '');
      facts.push({ kind: 'review', text: `A review requested changes (${who}), in these words: "${truncate(spoken(comments), 500)}"`, signature: sigOf('review', truncate(spoken(comments).toLowerCase(), 300)) });
    }
    for (const e of events.filter((x) => x.type === 'task.merge_conflict')) {
      const files = Array.isArray(e.data.conflicts) ? (e.data.conflicts as string[]) : [];
      facts.push({ kind: 'merge', text: `Merging your branch conflicted${files.length ? ` in ${files.join(', ')}` : ''}.`, signature: sigOf('conflict', [...files].sort().join(',')) });
    }
    for (const e of events.filter((x) => x.type === 'task.blocked')) {
      const reason = String(e.data.reason ?? '');
      facts.push({ kind: 'blocked', text: `The task was blocked: ${truncate(reason, 300)}`, signature: sigOf('blocked', truncate(reason.toLowerCase(), 200)) });
    }
    for (const e of events.filter((x) => x.type === 'task.unblocked' && !!spoken(String(x.data.note ?? '')))) {
      facts.push({ kind: 'blocked', text: `The boss unblocked it with this note: "${truncate(spoken(String(e.data.note)), 240)}"`, signature: null });
    }
    for (const q of this.core.questions.filter((x) => x.taskId === task.id && x.kind !== 'permission' && x.kind !== 'merge_conflict' && x.kind !== 'trust_prompt' && !!x.answer)) {
      const by = q.answeredBy?.kind === 'foreman' ? `${q.answeredBy.name} (the foreman)` : 'the boss';
      facts.push({ kind: 'question', text: `You asked "${truncate(q.text, 200)}" and ${by} answered: "${truncate(spoken(q.answer ?? ''), 200)}"`, signature: sigOf('question', truncate(q.text.toLowerCase(), 200)) });
    }
    for (const d of this.core.questions.filter((x) => x.taskId === task.id && x.kind === 'permission' && x.decision === 'deny')) {
      const command = this.commandOf(d);
      const note = spoken(d.answer ?? '');
      facts.push({ kind: 'denial', text: `The boss denied an action: ${truncate(command, 120)}${note ? ` — with the note: "${truncate(note, 200)}"` : ''}`, signature: sigOf('denial', shapeOf(command)) });
    }
    if (task.nudges > 0) facts.push({ kind: 'nudge', text: `You stopped ${times(task.nudges)} without finishing or asking, and had to be told to continue.`, signature: sigOf('nudge', '') });

    // What a person told them while the task was running: the place corrections arrive.
    if (task.startedAt && task.assigneeId) {
      const until = task.completedAt ?? '9999';
      const said = this.core.messages
        .filter((m) => m.toEmployeeId === task.assigneeId && m.from.kind === 'owner' && m.kind === 'chat' && m.createdAt >= task.startedAt! && m.createdAt <= until && !!spoken(m.body))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      for (const m of said.slice(-3)) facts.push({ kind: 'told', text: `While you worked on it, ${m.from.name} told you: "${truncate(spoken(m.body), 240)}"`, signature: null });
    }
    return facts;
  }

  private commandOf(q: Question): string {
    const command = (q.tool?.input as { command?: unknown } | null)?.command;
    return typeof command === 'string' && command.trim() ? command.trim() : q.tool ? `${q.tool.name} ${JSON.stringify(q.tool.input ?? {})}` : q.text.replace(/^.*wants to run: /, '');
  }

  /** A lesson this employee wrote that is about one of these frictions and is still in force. */
  private lessonAbout(employee: Employee, signatures: string[]): Lesson | undefined {
    return this.core.lessons
      .filter((l) => l.status === 'active' && l.authoredBy.kind === 'employee' && l.authoredBy.id === employee.id && l.captureOrigin?.kind === 'retrospective' && !!l.captureOrigin.signatures?.some((s) => signatures.some((x) => sameFriction(s, x))))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  }

  /**
   * The retrospective prompt for a finished task — or no prompt, when its author already holds a
   * lesson about exactly this and has not yet had the chance to use it. Sending is the caller's:
   * this decides only what to say, so it can never ask more often than the setting allows.
   */
  retrospective(task: Task, employee: Employee): { text: string | null; facts: RetroFact[]; revises: Lesson | null; skipped: string | null } {
    const facts = this.facts(task);
    const signatures = facts.map((x) => x.signature).filter((s): s is string => !!s);
    const covered = signatures.filter((s) => !!this.lessonAbout(employee, [s]));
    const known = covered.length ? this.lessonAbout(employee, covered) : undefined;
    // Did they have the lesson when this task began? Then it was in their prompt, and it happened anyway.
    const hadIt = !!known && !!task.startedAt && known.createdAt < task.startedAt;
    if (known && signatures.length && covered.length === signatures.length && !hadIt) {
      const why = `${employee.name} already recorded "${truncate(known.text, 100)}" about this after ${known.captureOrigin?.taskKey ?? 'an earlier task'}, and ${task.key} began before that lesson existed`;
      this.note('retro_skipped', `No retrospective for ${task.key}: ${employee.name} already holds a lesson about this`, { employeeId: employee.id, taskId: task.id, projectId: task.projectId }, { what: 'retrospective not sent', why, evidence: [{ kind: 'task', id: task.id, note: `${task.key} ${task.title}` }], undo: null, lessonId: known.id, quiet: true });
      return { text: null, facts, revises: null, skipped: why };
    }
    const revises = known && hadIt && covered.length === signatures.length ? known : null;
    const also = !known || revises ? '' : hadIt ? ` You already hold a lesson about part of this (id ${known.id}): "${truncate(known.text, 160)}". It was in your prompt for this task and that part happened again: if it needs sharpening, record the better version with replaces="${known.id}"; otherwise do not record it again.` : ` You already hold this one, so do not record it again: "${truncate(known.text, 160)}".`;
    const head = `${correlationMarker('RETRO', task.id)} Retrospective for ${task.key} "${task.title}" (verified and done).`;
    const record = facts.length ? `What Orchestrator recorded while you worked on it — facts from the record, nothing inferred:\n${facts.map((x) => `- [${x.kind}] ${x.text}`).join('\n')}` : 'It went through without recorded problems.';
    const shape = [
      '- lesson: the rule, written as an instruction to your future self — what to do, and to what.',
      '- applies_when: the concrete trigger — the kind of file, the kind of task, the tool or the moment (for example "before calling complete_task", "when editing *.sql migrations").',
      '- why: the evidence, in one sentence, taken from the facts above.',
      '- scope: "self" for your own playbook, "project" if everyone on this project should know it, "company" if it holds on every project.',
    ].join('\n');
    const ask = revises
      ? [
          `You already recorded a lesson about this (id ${revises.id}): "${revises.text}"${revises.appliesWhen ? ` — applies ${revises.appliesWhen}` : ''}. It was in your prompt for this task, and the same thing happened again.`,
          `Anything to change? If the lesson was too vague, did not say when it applies, or is wrong, record the sharper version with record_lesson and replaces="${revises.id}":`,
          shape,
          'If the lesson stands and this was a different matter, call record_lesson with none=true and a reason. Do not record the same lesson again, and do not change any code for this.',
        ].join('\n')
      : [
          'Is there a concrete, reusable lesson here that would make your next task go better? If so, record it with the record_lesson tool, in this shape:',
          shape,
          `Record at most 3, and only lessons grounded in the facts above. A lesson that does not say what to do or when ("be more careful") is refused.${also} If there is nothing worth keeping, call record_lesson with none=true and a reason. Do not change any code for this.`,
        ].join('\n');
    this.asked.set(employee.id, { taskId: task.id, signatures, revises: revises?.id ?? null });
    return { text: [head, '', record, '', ask].join('\n'), facts, revises, skipped: null };
  }

  /** record_lesson's arguments, checked. A refusal says what is missing and is kept on the record. */
  check(employee: Employee, args: LessonArgs): Extract<LessonCheck, { ok: true }> {
    const checked = checkLesson(args);
    if (checked.ok) return checked;
    this.note('lesson_refused', `${employee.name}'s lesson was sent back: ${checked.field} ${checked.field === 'lesson' ? 'too vague' : 'missing or too general'}`, { employeeId: employee.id, taskId: this.asked.get(employee.id)?.taskId ?? null, projectId: employee.projectId }, { what: 'record_lesson refused', why: checked.message, evidence: [], undo: null, field: checked.field, given: truncate(String(args.lesson ?? args.reason ?? ''), 200), quiet: true });
    throw new EngineError(checked.message);
  }

  /** The employee looked at the facts and found nothing to keep: their reason is the record. */
  nothingLearned(employee: Employee, taskId: string | null, reason: string): void {
    this.asked.delete(employee.id);
    const task = this.core.tasks.get(taskId);
    this.core.event({ type: 'learning.nothing_to_learn', source: 'mcp', summary: `${employee.name} found nothing to record${task ? ` from ${task.key}` : ''}: ${truncate(reason, 120)}`, employeeId: employee.id, taskId: task?.id ?? null, projectId: task?.projectId ?? employee.projectId, data: { auto: false, area: 'capture', what: 'no lesson recorded', why: reason, evidence: task ? [{ kind: 'task', id: task.id, note: `${task.key} ${task.title}` }] : [], undo: null, quiet: true } });
  }

  /**
   * A lesson an employee just recorded: keep its evidence sentence and what it is about, and retire
   * the lesson it replaces when they said so. Returns what to add to the tool's reply.
   */
  recorded(lesson: Lesson, employee: Employee, task: Task | undefined, checked: { why: string }, replaces: string | undefined): string {
    const ctx = this.asked.get(employee.id);
    const signatures = ctx && task && ctx.taskId === task.id ? ctx.signatures : task ? this.facts(task).map((x) => x.signature).filter((s): s is string => !!s) : [];
    lesson.captureWhy = lesson.captureWhy ?? checked.why;
    lesson.captureOrigin = lesson.captureOrigin ?? { kind: 'retrospective', toEmployeeId: employee.id, taskId: task?.id ?? null, taskKey: task?.key ?? null, signatures };
    this.core.put('lesson', lesson);
    const ref = replaces?.trim() || null;
    if (!ref) return '';
    const old = this.core.lessons.get(ref) ?? this.core.lessons.find((l) => ref.length >= 4 && l.id.startsWith(ref));
    if (!old || old.id === lesson.id || old.scope !== 'employee' || old.employeeId !== employee.id || old.status !== 'active') return ` (replaces="${ref}" was ignored: it is not an active lesson of your own playbook.)`;
    old.status = 'retired';
    old.updatedAt = new Date().toISOString();
    this.core.put('lesson', old);
    this.note('lesson_revised', `${employee.name} replaced a lesson that did not prevent a repeat: ${truncate(lesson.text, 100)}`, { employeeId: employee.id, taskId: task?.id ?? null, projectId: task?.projectId ?? null }, { what: `lesson ${old.id} retired in favour of ${lesson.id}`, why: `its author recorded a sharper version${task ? ` after ${task.key}` : ''}`, evidence: task ? [{ kind: 'task', id: task.id, note: `${task.key} ${task.title}` }] : [], undo: { lessonId: old.id, status: 'active' }, replacedBy: lesson.id });
    return ` It replaces your earlier lesson ${old.id}, which is retired.`;
  }

  // ───────────────────────── free candidates ────────────────────────

  /**
   * What the office does with a candidate nobody typed in as a lesson. It decides nothing new:
   * an employee's own playbook takes a rule as it always has, shared knowledge waits for the owner
   * unless shared lessons are approved automatically, and words that are not evidently a rule
   * (a review comment, a denial note) always wait.
   */
  private statusFor(scope: Lesson['scope'], readsAsRule: boolean): Lesson['status'] {
    if (!readsAsRule) return 'proposed';
    if (scope === 'employee') return 'active';
    return this.core.settings.selfImprovement.autoApproveSharedLessons ? 'active' : 'proposed';
  }

  private candidate(c: { scope: Lesson['scope']; employeeId: string | null; projectId: string | null; text: string; appliesWhen: string; evidence: EvidenceRef[]; readsAsRule: boolean; origin: CaptureOrigin; why: string; summary: string; taskId?: string | null }): Lesson | null {
    const text = c.text.trim().replace(/\s+/g, ' ');
    const employeeId = c.scope === 'employee' ? c.employeeId : null;
    const projectId = c.scope === 'project' ? c.projectId : null;
    // Once the owner has turned a derived candidate down, the same words are not offered again.
    if (c.origin.kind !== 'correction' && this.core.lessons.find((l) => l.status === 'retired' && l.scope === c.scope && l.employeeId === employeeId && l.projectId === projectId && l.text.toLowerCase() === truncate(text, 400).toLowerCase())) return null;
    const before = this.core.lessons.all().length;
    const lesson = this.eng.improver.saveCandidate({ scope: c.scope, employeeId, projectId, text, appliesWhen: c.appliesWhen, source: 'orchestrator', evidence: c.evidence, status: this.statusFor(c.scope, c.readsAsRule), authoredBy: { kind: 'orchestrator', id: null, name: 'Orchestrator' } });
    if (this.core.lessons.all().length === before) return lesson; // said before: the earlier record gained this evidence
    lesson.captureOrigin = c.origin;
    lesson.captureWhy = c.why;
    this.core.put('lesson', lesson);
    this.note('captured', c.summary, { employeeId: c.employeeId, taskId: c.taskId ?? null, projectId: c.projectId }, { what: `${lesson.status} ${lesson.scope} lesson ${lesson.id}: ${truncate(lesson.text, 160)}`, why: c.why, evidence: c.evidence, undo: { lessonId: lesson.id, status: 'retired' }, lessonId: lesson.id, origin: c.origin.kind, status: lesson.status });
    return lesson;
  }

  /** A person told an employee something. If it reads as a standing rule, keep it. */
  onMessage(msg: Message): Lesson | null {
    if (!this.on || msg.from.kind !== 'owner' || msg.kind !== 'chat') return null;
    return this.safely('message', () => {
      const found = detectCorrection(msg.body);
      const employee = this.core.employees.get(msg.toEmployeeId);
      if (!found || !employee) return null;
      const task = this.core.tasks.get(msg.taskId) ?? this.eng.tasks.currentTask(employee.id);
      const projectId = task?.projectId ?? employee.projectId;
      const scope: Lesson['scope'] = found.general && projectId ? 'project' : 'employee';
      const quote = truncate(spoken(msg.body), 300);
      const where = `${msg.from.name} to ${employee.name}${task ? ` during ${task.key}` : ''}`;
      return this.candidate({
        scope,
        employeeId: employee.id,
        projectId,
        text: found.rule,
        appliesWhen: '',
        evidence: [{ kind: 'message', id: msg.id, note: `${where}: "${truncate(quote, 140)}"` }, ...(task ? [{ kind: 'task' as const, id: task.id, note: `${task.key} ${task.title}` }] : [])],
        readsAsRule: true,
        origin: { kind: 'correction', from: msg.from.name, toEmployeeId: employee.id, taskId: task?.id ?? null, taskKey: task?.key ?? null, quote, matched: found.matched },
        why: `A message from ${where} reads as a standing rule (it contains "${found.matched}"). This is a wording match: nobody confirmed it is meant as a rule.`,
        summary: `Kept from ${msg.from.name}'s message to ${employee.name}: ${truncate(found.rule, 110)}`,
        taskId: task?.id ?? null,
      });
    }, null);
  }

  /** The owner sent work back: their comment is what the author should have known. */
  onReviewRejected(task: Task, comments: string): Lesson | null {
    if (!this.on || !task.assigneeId) return null;
    return this.safely('review', () => {
      const quote = truncate(spoken(comments).replace(/\s+/g, ' '), 300);
      const author = this.core.employees.get(task.assigneeId);
      if (!author || tokens(quote).length < 2) return null;
      const found = detectCorrection(comments);
      const scope: Lesson['scope'] = found?.general ? 'project' : 'employee';
      return this.candidate({
        scope,
        employeeId: author.id,
        projectId: task.projectId,
        text: found ? found.rule : `Review feedback from the boss on ${task.kind} work — "${quote}"`,
        appliesWhen: found ? '' : `before ${task.kind} work like ${task.key} goes to review`,
        evidence: [{ kind: 'review', id: task.id, note: `The boss requested changes on ${task.key}: "${truncate(quote, 140)}"` }, { kind: 'task', id: task.id, note: `${task.key} ${task.title}` }],
        readsAsRule: !!found,
        origin: { kind: 'review_rejection', from: 'the boss', toEmployeeId: author.id, taskId: task.id, taskKey: task.key, quote, ...(found ? { matched: found.matched } : {}) },
        why: `The boss requested changes on ${author.name}'s ${task.key}${found ? `, in words that read as a standing rule ("${found.matched}")` : '. Whether the comment holds beyond this task is for the owner to say, so it waits'}.`,
        summary: `Kept from the boss's review of ${task.key}: ${truncate(found?.rule ?? quote, 110)}`,
        taskId: task.id,
      });
    }, null);
  }

  /** The owner denied an action and said why: the note is the lesson, the command is its trigger. */
  onDenied(q: Question): Lesson | null {
    if (!this.on || q.kind !== 'permission' || q.decision !== 'deny' || !q.employeeId) return null;
    return this.safely('denial', () => {
      const note = truncate(spoken(q.answer ?? '').replace(/\s+/g, ' '), 240);
      const employee = this.core.employees.get(q.employeeId);
      if (!employee || tokens(note).length < 1 || note.length < 6) return null;
      const command = truncate(this.commandOf(q).replace(/\s+/g, ' '), 140);
      const task = this.core.tasks.get(q.taskId);
      const found = detectCorrection(note);
      const scope: Lesson['scope'] = found?.general && q.projectId ? 'project' : 'employee';
      return this.candidate({
        scope,
        employeeId: employee.id,
        projectId: q.projectId,
        text: found ? found.rule : `The boss denied "${command}" with the note: "${note}"`,
        appliesWhen: `before asking to run "${shapeOf(command)}"`,
        evidence: [{ kind: 'approval', id: q.id, note: `Denied: ${truncate(command, 90)} — "${truncate(note, 80)}"` }, ...(task ? [{ kind: 'task' as const, id: task.id, note: `${task.key} ${task.title}` }] : [])],
        readsAsRule: !!found,
        origin: { kind: 'denial', from: 'the boss', toEmployeeId: employee.id, taskId: task?.id ?? null, taskKey: task?.key ?? null, quote: `${command} — ${note}`, ...(found ? { matched: found.matched } : {}) },
        why: `The boss denied ${employee.name}'s request to run "${command}" and gave a reason${found ? ` that reads as a standing rule ("${found.matched}")` : '. Whether it holds beyond this request is for the owner to say, so it waits'}.`,
        summary: `Kept from a denied request of ${employee.name}'s: ${truncate(found?.rule ?? note, 110)}`,
        taskId: task?.id ?? null,
      });
    }, null);
  }

  // ───────────────────────────── repeats ───────────────────────────

  /**
   * A new question that reads like one already answered in the same project. The earlier answer is
   * attached for whoever answers (returned as a line for the notification, and kept on the
   * question); the question itself is left open. If that answer exists as project knowledge, the
   * knowledge evidently did not reach this session: it is flagged so retrieval gives it next time.
   */
  repeatedQuestion(q: Question): string | null {
    if (!this.on || !q.projectId || !q.employeeId || q.channel === 'system' || q.kind === 'permission' || q.kind === 'trust_prompt' || q.kind === 'merge_conflict' || q.kind === 'priority') return null;
    return this.safely('repeat', () => {
      let best: { q: Question; score: number } | null = null;
      for (const x of this.core.questions.filter((e) => e.id !== q.id && e.projectId === q.projectId && e.kind !== 'permission' && e.kind !== 'trust_prompt' && e.kind !== 'merge_conflict' && e.kind !== 'priority' && !!e.answeredAt && !!spoken(e.answer ?? ''))) {
        const score = questionSimilarity(q.text, x.text);
        if (score >= REPEAT_THRESHOLD && (!best || score > best.score || (score === best.score && (x.answeredAt ?? '') > (best.q.answeredAt ?? '')))) best = { q: x, score };
      }
      if (!best) return null;
      const earlier = best.q;
      const asker = this.core.employees.get(q.employeeId);
      const askedBy = this.core.employees.get(earlier.employeeId)?.name ?? null;
      const answeredBy = earlier.answeredBy?.kind === 'foreman' ? `${earlier.answeredBy.name} (the foreman)` : 'the boss';
      const answer = truncate(spoken(earlier.answer ?? ''), 240);
      const knowledge = this.core.lessons.find((l) => l.status === 'active' && l.source === 'owner_answer' && l.evidence.some((e) => e.kind === 'question' && e.id === earlier.id));
      q.captureAnsweredBefore = { questionId: earlier.id, text: truncate(earlier.text, 200), answer, answeredAt: earlier.answeredAt, askedBy, answeredBy, lessonId: knowledge?.id ?? null, similarity: Math.round(best.score * 100) / 100 };
      const evidence: EvidenceRef[] = [{ kind: 'question', id: earlier.id, note: `Asked before${askedBy ? ` by ${askedBy}` : ''}: ${truncate(earlier.text, 100)}` }, { kind: 'question', id: q.id, note: `Asked again${asker ? ` by ${asker.name}` : ''}: ${truncate(q.text, 100)}` }];
      const at = { employeeId: q.employeeId, taskId: q.taskId, projectId: q.projectId };
      if (knowledge) {
        const was = knowledge.captureMustInclude ?? 0;
        knowledge.captureMustInclude = was + 1;
        this.core.put('lesson', knowledge);
        this.note('knowledge_missed', `${asker?.name ?? 'An employee'} asked something the project already knows: ${truncate(q.text, 90)}`, at, { what: `lesson ${knowledge.id} flagged must-include (${was} → ${was + 1})`, why: `The question reads like one ${answeredBy} already answered (${Math.round(best.score * 100)}% of the words in common), and that answer is active project knowledge — it did not reach, or did not register with, the session that asked.`, evidence, undo: { lessonId: knowledge.id, captureMustInclude: was }, lessonId: knowledge.id, questionId: q.id, earlierQuestionId: earlier.id });
      } else {
        this.note('question_repeated', `${asker?.name ?? 'An employee'} asked something answered before: ${truncate(q.text, 90)}`, at, { what: 'earlier answer attached to the question', why: `The question reads like one ${answeredBy} already answered (${Math.round(best.score * 100)}% of the words in common). That answer is not active project knowledge, so there was nothing to give the session.`, evidence, undo: null, questionId: q.id, earlierQuestionId: earlier.id, quiet: true });
      }
      return `Answered before${askedBy ? ` (asked by ${askedBy})` : ''}, by ${answeredBy}: "${answer}"${knowledge ? ' — this is project knowledge already, and was asked again anyway.' : ''}`;
    }, null);
  }

  // ───────────────────────────── failures ──────────────────────────

  /**
   * Verification failed. If the same command failed with nearly the same words on another task of
   * the project, that is a fact about the project worth telling everyone: proposed as knowledge,
   * citing every task it was seen on.
   */
  onVerificationFailed(task: Task, project: Project, command: string, result: { timedOut?: boolean; outputTail?: string }): Lesson | null {
    // A timeout says the limit is wrong, which is a process proposal and somebody else's finding.
    if (!this.on || result.timedOut) return null;
    return this.safely('failure', () => {
      const sig = failureSignature(command, String(result.outputTail ?? ''));
      if (!sig.lines.length) return null;
      const earlier = this.core.store.queryEvents({ projectId: project.id, types: ['task.verification_failed'], limit: 400 }).filter((e) => !!e.taskId && e.taskId !== task.id && !e.data.timedOut && sameFailure(sig, failureSignature(String(e.data.command ?? ''), String(e.data.outputTail ?? ''))));
      const others = [...new Set(earlier.map((e) => e.taskId!))].map((id) => this.core.tasks.get(id)).filter((t): t is Task => !!t);
      if (!others.length) return null;
      const seen = [...others.slice(-5), task];
      const key = sigOf('verify', `${sig.command}\n${sig.lines.join('\n')}`);
      const where = commonGround(seen.map((t) => t.evidence.filesChanged ?? []));
      const text = (tasks: Task[]) => `"${sig.command}" fails with "${sig.headline}"${where ? ` when ${where} changes` : ''} — seen in ${tasks.map((t) => t.key).join(', ')}.`;
      const known = this.core.lessons.find((l) => l.projectId === project.id && l.captureOrigin?.kind === 'repeat_failure' && !!l.captureOrigin.signatures?.some((s) => sameFriction(s, key)));
      if (known) {
        // Seen once more: the same record gains the task, unless the owner already turned it down or reworded it.
        if (known.status === 'retired' || known.evidence.some((e) => e.kind === 'task' && e.id === task.id)) return known;
        const cited = known.evidence.filter((e) => e.kind === 'task').map((e) => this.core.tasks.get(e.id)).filter((t): t is Task => !!t);
        if (/ — seen in [A-Z0-9, -]+\.$/.test(known.text)) known.text = truncate(known.text.replace(/ — seen in [^—]*$/, ` — seen in ${[...cited, task].map((t) => t.key).join(', ')}.`), 400);
        known.evidence.push({ kind: 'task', id: task.id, note: `${task.key} ${task.title}` });
        known.updatedAt = new Date().toISOString();
        this.core.put('lesson', known);
        this.note('failure_seen_again', `${task.key} failed verification the way ${cited.map((t) => t.key).join(', ')} did: ${truncate(sig.headline, 90)}`, { employeeId: task.assigneeId, taskId: task.id, projectId: project.id }, { what: `${task.key} added to the evidence of lesson ${known.id}`, why: 'the same command failed with nearly the same failing lines', evidence: [{ kind: 'task', id: task.id, note: `${task.key} ${task.title}` }], undo: null, lessonId: known.id, quiet: true });
        return known;
      }
      return this.candidate({
        scope: 'project',
        employeeId: task.assigneeId,
        projectId: project.id,
        text: text(seen),
        appliesWhen: where ? `when changing ${where}` : `when "${sig.command}" fails in ${project.name}`,
        evidence: seen.map((t) => ({ kind: 'task' as const, id: t.id, note: `${t.key} ${t.title}` })),
        readsAsRule: true,
        origin: { kind: 'repeat_failure', taskId: task.id, taskKey: task.key, quote: redactSecrets(tail(String(result.outputTail ?? ''), 300)), signatures: [key] },
        why: `Verification failed the same way on ${seen.length} tasks of ${project.name}: the same command, and at least ${Math.round(0.6 * 100)}% of the words of its failing lines in common once paths and numbers are ignored. What is recorded is that it happens, not what causes it.`,
        summary: `The same verification failure on ${seen.map((t) => t.key).join(' and ')} in ${project.name}: ${truncate(sig.headline, 90)}`,
        taskId: task.id,
      });
    }, null);
  }

  // ──────────────────────────── onboarding ─────────────────────────

  /**
   * "What this team has learned", once, with an employee's first task on a project. The task
   * prompt already carries the playbook (the lessons `included`), the verification command and the
   * task itself, so the digest holds only what those leave out: active knowledge that did not fit
   * the playbook, and what the record shows about where work here goes wrong.
   */
  onboardingBlock(employee: Employee, project: Project, included?: Lesson[]): string {
    if (!this.on) return '';
    return this.safely('onboarding', () => {
      if (employee.captureOnboarded?.includes(project.id)) return '';
      const was = employee.captureOnboarded ?? [];
      employee.captureOnboarded = [...was, project.id];
      this.core.put('employee', employee);
      // Someone who already worked here (before this existed, too) is not new.
      if (this.core.tasks.filter((t) => t.projectId === project.id && t.assigneeId === employee.id && !!t.startedAt).length > 1) return '';

      const have = new Set((included ?? this.eng.improver.lessonsFor(employee, project.id)).map((l) => l.id));
      const lines: string[] = [];
      const knowledge = this.core.lessons
        .filter((l) => l.status === 'active' && !have.has(l.id) && ((l.scope === 'project' && l.projectId === project.id) || l.scope === 'company'))
        .sort((a, b) => (b.captureMustInclude ?? 0) - (a.captureMustInclude ?? 0) || b.appliedCount - a.appliedCount || (a.createdAt < b.createdAt ? 1 : -1));
      for (const l of knowledge) lines.push(`- ${truncate(l.text, 220)}${l.appliesWhen ? ` (applies ${l.appliesWhen})` : ''}`);

      // Where merges collided: nobody is told this unless they collide there themselves.
      const files = new Map<string, number>();
      for (const e of this.core.store.queryEvents({ projectId: project.id, types: ['task.merge_conflict'], limit: 200 })) for (const f of (e.data.conflicts as string[] | undefined) ?? []) files.set(f, (files.get(f) ?? 0) + 1);
      const hot = [...files].sort((a, b) => b[1] - a[1]).slice(0, 4);
      if (hot.length) lines.push(`- Merges have conflicted in ${hot.map(([f, n]) => `${f}${n > 1 ? ` (${n}×)` : ''}`).join(', ')}: merge "${project.integrationBranch}" into your branch before you finish work that touches ${hot.length === 1 ? 'it' : 'them'}.`);

      // How verification most often failed here, unless that is already a lesson of its own.
      const failures = this.core.store.queryEvents({ projectId: project.id, types: ['task.verification_failed'], limit: 200 }).filter((e) => !e.data.timedOut);
      const groups: Array<{ sig: FailureSignature; tasks: Set<string> }> = [];
      for (const e of failures) {
        const sig = failureSignature(String(e.data.command ?? ''), String(e.data.outputTail ?? ''));
        const g = groups.find((x) => sameFailure(x.sig, sig));
        if (g) g.tasks.add(String(e.data.key ?? e.taskId));
        else groups.push({ sig, tasks: new Set([String(e.data.key ?? e.taskId)]) });
      }
      const worst = groups.filter((g) => g.tasks.size >= 2).sort((a, b) => b.tasks.size - a.tasks.size)[0];
      if (worst && !this.core.lessons.find((l) => l.status === 'active' && l.projectId === project.id && l.captureOrigin?.kind === 'repeat_failure' && !!l.captureOrigin.signatures?.some((s) => sameFriction(s, sigOf('verify', `${worst.sig.command}\n${worst.sig.lines.join('\n')}`))))) {
        lines.push(`- "${worst.sig.command}" has failed the same way on ${worst.tasks.size} tasks here (${[...worst.tasks].slice(0, 4).join(', ')}): "${truncate(worst.sig.headline, 120)}".`);
      }
      if (!lines.length) return '';

      const head = `What this team has learned on ${project.name} so far (given once, because this is your first task here):`;
      const kept: string[] = [];
      let size = head.length;
      for (const line of lines) {
        if (size + 1 + line.length > ONBOARDING_BUDGET) continue;
        kept.push(line);
        size += 1 + line.length;
      }
      if (!kept.length) return '';
      const lessonIds = knowledge.filter((l) => kept.some((k) => k.startsWith(`- ${truncate(l.text, 220)}`))).map((l) => l.id);
      this.note('onboarded', `${employee.name} was given what the team has learned on ${project.name}`, { employeeId: employee.id, projectId: project.id }, { what: `onboarding digest of ${kept.length} line${kept.length === 1 ? '' : 's'} added to the first task prompt`, why: `${employee.name} has not worked on ${project.name} before`, evidence: [], undo: { employeeId: employee.id, captureOnboarded: was }, lessonIds, lines: kept.length, omitted: lines.length - kept.length, quiet: true });
      return [head, ...kept].join('\n');
    }, '');
  }

  // ────────────────────────────── skills ───────────────────────────

  /** What an employee's finished work shows: counted from task records and hook events, nothing declared. */
  measuredSkills(employeeId: string): MeasuredSkill[] {
    const done = this.core.tasks.filter((t) => t.assigneeId === employeeId && t.status === 'DONE' && t.kind !== 'review' && !!t.evidence.summary);
    const kinds = new Map<string, { count: number; firstPass: number }>();
    const types = new Map<string, number>();
    const dirs = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const t of done) {
      const k = kinds.get(t.kind) ?? { count: 0, firstPass: 0 };
      k.count++;
      if (t.friction.failedVerifications === 0 && t.friction.reviewRejections === 0) k.firstPass++;
      kinds.set(t.kind, k);
      // Each task counts once per file type and directory, however many files it changed there.
      for (const x of new Set((t.evidence.filesChanged ?? []).map(fileType).filter(Boolean))) bump(types, x);
      for (const x of new Set((t.evidence.filesChanged ?? []).map(directoryOf).filter(Boolean))) bump(dirs, x);
    }
    const tools = new Map<string, number>();
    for (const e of this.core.store.queryEvents({ employeeId, types: ['agent.tool_finished'], limit: 2000 })) if (typeof e.data.tool === 'string' && e.data.tool) bump(tools, e.data.tool);
    const top = (m: Map<string, number>, kind: MeasuredSkill['kind'], n: number): MeasuredSkill[] => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([label, count]) => ({ kind, label, count }));
    return [
      ...[...kinds].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1)).map(([label, v]) => ({ kind: 'task_kind' as const, label, count: v.count, firstPass: v.firstPass })),
      ...top(types, 'file_type', 5),
      ...top(dirs, 'directory', 5),
      ...top(tools, 'tool', 5),
    ];
  }

  /** Keep an employee's measured skills current. Called when a task of theirs is done. */
  refreshSkills(employeeId: string | null): void {
    if (!this.on || !employeeId) return;
    this.safely('skills', () => {
      const employee = this.core.employees.get(employeeId);
      if (!employee) return;
      const skills = this.measuredSkills(employeeId);
      if (JSON.stringify(skills) === JSON.stringify(employee.captureSkills ?? [])) return;
      employee.captureSkills = skills;
      this.core.put('employee', employee);
    }, undefined);
  }

  /** One line for a colleague deciding whom to ask: what this person has delivered here. */
  skillsLine(employee: Employee): string {
    const s = employee.captureSkills ?? [];
    const kinds = s.filter((x) => x.kind === 'task_kind').slice(0, 3).map((x) => `${x.label} ${x.firstPass ?? 0}/${x.count} first pass`);
    const where = [...s.filter((x) => x.kind === 'directory').slice(0, 2), ...s.filter((x) => x.kind === 'file_type').slice(0, 2)].map((x) => x.label);
    return [kinds.length ? `delivered: ${kinds.join(', ')}` : '', where.length ? `mostly in ${where.join(', ')}` : ''].filter(Boolean).join('; ');
  }
}

/** "npm test", "git push": the first words of a command, enough to say which kind it is. */
function shapeOf(command: string): string {
  const words = (command.trim().split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return command.trim();
  return words[1] && !words[1].startsWith('-') && /^(npm|pnpm|yarn|git|docker|cargo|go|make|npx|python|python3|php|composer|kubectl|pip|bundle)$/.test(words[0]!) ? `${words[0]} ${words[1]}` : words[0]!;
}

function fileType(file: string): string {
  const base = file.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : base;
}

function directoryOf(file: string): string {
  const parts = file.split('/').slice(0, -1);
  return parts.slice(0, 2).join('/');
}

/** The directory (or file) every one of these change sets touched, if there is one. */
function commonGround(changes: string[][]): string {
  if (changes.length < 2 || changes.some((c) => !c.length)) return '';
  const shared = (pick: (f: string) => string) => {
    const [first, ...rest] = changes.map((c) => new Set(c.map(pick).filter(Boolean)));
    return [...first!].filter((x) => rest.every((s) => s.has(x))).sort();
  };
  const files = shared((f) => f);
  if (files.length) return files.slice(0, 2).join(', ');
  return shared(directoryOf).slice(0, 2).join(', ');
}
