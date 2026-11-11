import type { Employee, EvidenceRef, Improvement, ImprovementAction, ImprovementKind, Lesson, LessonPlaybookMeta, LessonSource, OrchestratorEvent, OwnerSettings, Task, TaskKind } from '@orchestrator/contracts';
import { newId, nowIso, truncate } from '@orchestrator/contracts';
import { EngineError } from '../core.ts';
import type { Engine } from '../engine.ts';

/**
 * The playbook: which lessons go into a task's prompt, and keeping the lessons themselves tidy.
 *
 *  - Relevance: the lessons of a task prompt are chosen by how well their words fit the task
 *    (a small TF-IDF over the lessons), with boosts for whose lesson it is, the kind of task and
 *    the files involved, inside a character budget. Every choice is recorded with its reasons.
 *  - No duplicates: a lesson recorded again in other words is folded into the one already there.
 *  - Promotion: what two employees of a project learn independently becomes a project lesson.
 *  - Contradictions: two lessons that say opposite things are put to the owner, never decided here.
 *  - Staleness: a lesson that keeps being included without ever fitting the task is ranked down.
 *
 * All of it is arithmetic over text the office already holds: no model is asked anything, so it
 * costs no Claude usage. The top half of this file is pure functions; the class at the bottom
 * applies them to the office's records.
 */

// ───────────────────────────── tuning ─────────────────────────────

/** Characters of lessons a task prompt may carry, unless the owner's settings say otherwise. */
export const DEFAULT_BUDGET_CHARS = 2400;
const MIN_BUDGET_CHARS = 400;
const MAX_BUDGET_CHARS = 8000;
/** The employee's newest lessons that get a place whatever they score, so a fresh lesson is tried before it has matched anything. */
export const NEWEST_OWN_QUOTA = 2;
/** Text relevance at or above this counts as "the lesson fitted the task". */
export const MATCH_THRESHOLD = 0.12;
/** Included this many task prompts in a row without fitting the task: ranked down from then on. */
export const STALE_AFTER = 8;
const STALE_FACTOR = 0.5;
const SCOPE_BOOST: Record<Lesson['scope'], number> = { employee: 0.15, project: 0.08, company: 0 };
const KIND_BOOST = 0.08;
/** Knowledge that was asked about again although it existed goes ahead of anything that only shares words with the task. */
const MISSED_BOOST = 1;
/** A lesson measured to help is preferred among lessons that fit about as well. */
const PROVEN_BOOST = 0.06;
const SAME_FILE_BOOST = 0.2;
const SAME_DIR_BOOST = 0.1;
/**
 * How much matching it takes to be relevant: relevance is matched / (matched + SATURATION), where "matched" adds up,
 * per word the lesson shares with the task, how rare the word is among the lessons (0–1) × where it stands in the
 * lesson (1, or 1.5 in "applies when") × where it stands in the task (1 in the title, down to 0.3). One rare word of
 * an "applies when" note found in a task's title gives about 0.43; one common word from a description, under 0.1.
 */
const SATURATION = 2;
/** Two lessons are the same lesson reworded at or above this (rarity-weighted overlap of their words, 0–1). */
export const DUPLICATE_SIMILARITY = 0.72;
/** …or when nearly all of the shorter one is inside the longer one. */
const CONTAINED_SIMILARITY = 0.9;
const CONTAINED_MIN_OVERLAP = 0.35;
const MAX_MERGE_RECORDS = 8;
const MAX_EVIDENCE = 24;

/** The playbook's settings with defaults and bounds applied (they are optional in stored settings). */
export function playbookSettings(settings: Pick<OwnerSettings, 'selfImprovement'>): { relevance: boolean; budgetChars: number } {
  const s = settings.selfImprovement;
  const n = s.playbookBudgetChars;
  return {
    relevance: s.playbookRelevance !== false,
    budgetChars: typeof n === 'number' && Number.isFinite(n) ? Math.min(MAX_BUDGET_CHARS, Math.max(MIN_BUDGET_CHARS, Math.round(n))) : DEFAULT_BUDGET_CHARS,
  };
}

// ───────────────────────────── words ──────────────────────────────

const STOP_WORDS = new Set(
  `a an the and or but if then else so of to in on at by for from with into onto over under up down out off as is are was were be been being am
  do does did done doing have has had having it its this that these those there here i you your yours we our us they them their he she his her me my
  who whom whose which what when where why how all any both each few more most other some such only own same than too very can will just should would
  could may might must shall also about again after before during while until against between through per via etc eg ie one get got make made makes
  making need needs needed use used using uses let lets want wants sure please always ensure every thing things something anything`.split(/\s+/),
);

/** Words that turn an instruction into its opposite. Counted, not kept: an odd number makes the lesson a prohibition. */
const NEGATIONS = new Set(['never', 'not', 'no', 'nor', 'neither', 'without', 'avoid', 'avoids', 'avoiding', 'stop', 'dont', 'doesnt', 'didnt', 'cannot', 'cant', 'wont', 'shouldnt', 'mustnt', 'isnt', 'arent', 'neednt']);

/** Short forms developers write, as the word they stand for. */
const ALIASES: Record<string, string> = {
  db: 'database', dbs: 'database', repo: 'repository', repos: 'repository', config: 'configuration', configs: 'configuration', cfg: 'configuration',
  env: 'environment', envs: 'environment', dep: 'dependency', deps: 'dependency', doc: 'documentation', docs: 'documentation', auth: 'authentication',
  dir: 'directory', dirs: 'directory', param: 'parameter', params: 'parameter', arg: 'argument', args: 'argument', msg: 'message', pkg: 'package', prs: 'pr',
};

/** Word families a suffix rule cannot join (configure / configuration, verify / verification): the shared beginning stands for all of them. */
const ROOTS = ['migrat', 'configur', 'document', 'install', 'implement', 'authenti', 'authoriz', 'optimi', 'verif', 'validat', 'depend', 'deploy', 'environment', 'databas', 'repositor', 'initiali', 'serializ', 'generat', 'integrat', 'refactor', 'deprecat', 'compil', 'format'];

function undouble(w: string): string {
  return w.length >= 4 && w.at(-1) === w.at(-2) && !/[lsz]$/.test(w) ? w.slice(0, -1) : w;
}

/** A light stemmer for English: plurals, -ing, -ed, -ion, a final e. Words in other languages pass through unchanged. */
export function stem(word: string): string {
  let w = ALIASES[word] ?? word;
  if (w.length <= 3 || !/^[a-z]+$/.test(w)) return w;
  for (const r of ROOTS) if (w.startsWith(r)) return r;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (/(ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = undouble(w.slice(0, -3));
  else if (w.length > 4 && w.endsWith('ed')) w = w.length === 5 ? w.slice(0, -1) : undouble(w.slice(0, -2));
  else if (w.length > 5 && /[st]ion$/.test(w)) w = w.slice(0, -3);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('y')) w = `${w.slice(0, -1)}i`;
  return w;
}

/** Every word of a text, lower-cased; camelCase and paths come apart, apostrophes vanish ("don't" → "dont"). */
export function words(text: string): string[] {
  return text
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The words that carry meaning, stemmed: no stop-words, no negations, no stray single letters (single digits stay). */
export function terms(text: string): string[] {
  return words(text)
    .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP_WORDS.has(w) && !NEGATIONS.has(w))
    .map(stem);
}

/** File paths written in a text ("src/db/schema.ts", "package.json"). */
export function pathsIn(text: string): string[] {
  // (A path begins where a run of its characters begins, and its parts have a longest length: otherwise a long run of
  // letters is read again from each of its characters. Only the first stretch of a very long text is looked at.)
  return [...new Set(text.slice(0, 200_000).match(/(?<![\w.@\/-])(?:[\w.@-]{1,120}\/)+[\w.@-]{1,120}|(?<![\w-])[\w-]{1,120}\.(?:tsx?|jsx?|mjs|cjs|json|md|py|go|rs|sql|s?css|html|ya?ml|toml|sh|rb|php|java|kt|swift|cpp|c|h)\b/g) ?? [])];
}

const dirOf = (file: string): string => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');

// ─────────────────────────── similarity ───────────────────────────

interface Profile {
  /** The text reduced to its words, in order: equal profiles are the same sentence. */
  norm: string;
  terms: Set<string>;
  /** Figures and labels (ports, versions, sizes, "option B"): two lessons that differ in these are not the same lesson. */
  numbers: string[];
  /** True when the text is a prohibition (an odd number of negating words). */
  negative: boolean;
}

/** A captured answer starts with the same few words every time; they say nothing about which decision it is. */
const body = (text: string) => text.replace(/^Decided by the boss —\s*/i, '');

/** Profiles depend on the text alone and every pass compares the same lessons again, so they are kept. */
const profiles = new Map<string, Profile>();

function profile(raw: string): Profile {
  const known = profiles.get(raw);
  if (known) return known;
  const text = body(raw);
  const all = words(text);
  const t = new Set(terms(text));
  const figures = all.filter((w) => /\d/.test(w) || (w.length === 1 && !STOP_WORDS.has(w)));
  const made: Profile = { norm: all.join(' '), terms: t, numbers: [...new Set(figures)].sort(), negative: all.filter((w) => NEGATIONS.has(w)).length % 2 === 1 };
  if (profiles.size >= 4000) profiles.clear();
  profiles.set(raw, made);
  return made;
}

type Idf = (term: string) => number;

/** How rare each term is across a set of texts: a term in every text weighs 1, a term in one weighs more. */
function idfOf(docs: Array<Iterable<string>>): Idf {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return (t) => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;
}

function overlap(a: Set<string>, b: Set<string>, idf: Idf): { similarity: number; contained: number } {
  let shared = 0;
  let wa = 0;
  let wb = 0;
  for (const t of a) {
    wa += idf(t);
    if (b.has(t)) shared += idf(t);
  }
  for (const t of b) wb += idf(t);
  const union = wa + wb - shared;
  const smaller = Math.min(wa, wb);
  return { similarity: union > 0 ? shared / union : 0, contained: smaller > 0 ? shared / smaller : 0 };
}

export type Verdict = 'duplicate' | 'contradiction' | 'different';

export interface Comparison {
  verdict: Verdict;
  /** Share of their meaningful words the two texts have in common, 0–1 (the lower of the plain and the rarity-weighted count). */
  similarity: number;
  /** Why a contradiction: 'polarity' (one forbids what the other asks), 'numbers' (same sentence, different figures), 'decision' (two answers of the boss to what reads as one question). */
  reason: 'polarity' | 'numbers' | 'decision' | null;
}

/**
 * Are two lesson texts the same lesson, opposite lessons, or different ones?
 *
 * The same words in the same order are a duplicate. Otherwise the texts must share most of their
 * meaningful words (also when weighted by rarity, if `idf` is given). Then: opposite polarity or
 * different figures make a contradiction, anything else a duplicate. `exactOnly` is for the boss's
 * recorded decisions, where a different answer to the same question must never be folded away.
 *
 * This compares which words are used, not what the sentence means or the order they come in:
 * synonyms are missed, and "restore the database before migrating" reads the same as "migrate
 * before restoring the database". That is why merges are recorded and can be undone.
 */
export function compareTexts(a: string, b: string, opts: { idf?: Idf; exactOnly?: boolean } = {}): Comparison {
  const pa = profile(a);
  const pb = profile(b);
  if (pa.norm === pb.norm) return { verdict: 'duplicate', similarity: 1, reason: null };
  const size = Math.min(pa.terms.size, pb.terms.size);
  // Counted both plainly and weighted by rarity, and the lower one decides: neither a shared rare word nor a
  // pile of shared common ones is enough on its own.
  const plain = overlap(pa.terms, pb.terms, () => 1);
  if (plain.similarity < CONTAINED_MIN_OVERLAP) return { verdict: 'different', similarity: Math.round(plain.similarity * 1000) / 1000, reason: null };
  const weighted = opts.idf ? overlap(pa.terms, pb.terms, opts.idf) : plain;
  const o = { similarity: Math.min(plain.similarity, weighted.similarity), contained: Math.min(plain.contained, weighted.contained) };
  const similarity = Math.round(o.similarity * 1000) / 1000;
  const different: Comparison = { verdict: 'different', similarity, reason: null };
  // Under three meaningful words there is too little to say two different sentences mean the same.
  if (size < 3) return different;
  const close = o.similarity >= DUPLICATE_SIMILARITY;
  // One lesson inside a longer one that adds detail: the same lesson, but too loose a likeness to call anything a contradiction.
  const inside = size >= 4 && o.contained >= CONTAINED_SIMILARITY && o.similarity >= CONTAINED_MIN_OVERLAP;
  if (!close && !inside) return different;
  const reason = opts.exactOnly ? 'decision' : pa.negative !== pb.negative ? 'polarity' : pa.numbers.join(' ') !== pb.numbers.join(' ') ? 'numbers' : null;
  if (reason) return close ? { verdict: 'contradiction', similarity, reason } : different;
  return { verdict: 'duplicate', similarity, reason: null };
}

/** A recorded decision of the boss: reworded copies of these are never assumed to be the same decision. */
const isDecision = (l: { source: LessonSource }) => l.source === 'owner_answer';
/** The question of a captured answer (`Decided by the boss — "question": answer`). */
const questionOf = (text: string) => /^Decided by the boss — "([\s\S]*?)": /.exec(text)?.[1] ?? null;

/** Compare two lessons; `idf` (from `lessonIdf`) makes rare words count for more than common ones. */
export function compareLessons(a: Pick<Lesson, 'text' | 'source'>, b: Pick<Lesson, 'text' | 'source'>, idf?: Idf): Comparison {
  if (!isDecision(a) && !isDecision(b)) return compareTexts(a.text, b.text, { idf });
  const whole = compareTexts(a.text, b.text, { idf, exactOnly: true });
  const qa = isDecision(a) && isDecision(b) ? questionOf(a.text) : null;
  const qb = qa ? questionOf(b.text) : null;
  if (whole.verdict !== 'different' || !qa || !qb) return whole;
  // Two answers to one question: whatever the answers say, the boss should see that there are two.
  const asked = compareTexts(qa, qb, { idf });
  return asked.verdict === 'duplicate' ? { verdict: 'contradiction', similarity: asked.similarity, reason: 'decision' } : whole;
}

/** Rarity of words across lesson texts, for `compareLessons`. */
export function lessonIdf(lessons: Array<Pick<Lesson, 'text'>>): Idf {
  return idfOf(lessons.map((l) => profile(l.text).terms));
}

type Wording = Pick<Lesson, 'text' | 'appliesWhen' | 'authoredBy'>;

/** Which of two wordings to keep: the owner's over an employee's, then the one that says more, then the longer, then the first. */
export function clearerText<A extends Wording, B extends Wording>(a: A, b: B): A | B {
  const owner = (x: Wording) => (x.authoredBy.kind === 'owner' ? 1 : 0);
  if (owner(a) !== owner(b)) return owner(a) ? a : b;
  const said = (x: Wording) => new Set(terms(x.text)).size;
  if (said(a) !== said(b)) return said(a) > said(b) ? a : b;
  return b.text.length > a.text.length ? b : a;
}

function unionEvidence(a: EvidenceRef[], b: EvidenceRef[]): { all: EvidenceRef[]; added: EvidenceRef[] } {
  const all = [...a];
  const added: EvidenceRef[] = [];
  for (const ev of b) {
    if (all.length >= MAX_EVIDENCE || all.some((e) => e.kind === ev.kind && e.id === ev.id)) continue;
    all.push(ev);
    added.push(ev);
  }
  return { all, added };
}

// ─────────────────────────── relevance ────────────────────────────

/** What is known about the task a prompt is for. */
export interface TaskContext {
  title: string;
  description: string;
  acceptance: string;
  kind: TaskKind | null;
  projectName: string;
  /** Files the task is known to touch: changed by its earlier attempts, by the work it reviews, or named in its text. */
  files: string[];
  /** Files next to it (what the tasks it depends on changed): only their directories count. */
  nearFiles: string[];
}

/** What a lesson's evidence says about where it came from. */
export interface LessonFacts {
  /** Kinds of the tasks it was learned on. */
  kinds: TaskKind[];
  /** Files those tasks changed. */
  files: string[];
}

export interface ChosenLesson {
  lesson: Lesson;
  /** What it was ranked by: relevance plus boosts, halved when stale. */
  score: number;
  /** How well the lesson's wording fits the task's, 0–1 (see SATURATION for the arithmetic). */
  relevance: number;
  /** The task's words that the lesson matched, as written in the task. */
  matched: string[];
  /** Why it is in the prompt, in plain words. */
  reasons: string[];
  /** It fitted this task: by its wording (relevance at or above the match threshold) or by the files it was learned on. */
  fits: boolean;
  /** It holds one of the places kept for the employee's newest lessons. */
  newestOwn: boolean;
}

export interface Selection {
  chosen: ChosenLesson[];
  /** Lessons that applied but were not included, best first. */
  leftOut: Array<{ id: string; score: number; why: 'budget' | 'duplicate'; of?: string }>;
  usedChars: number;
  budgetChars: number;
  considered: number;
}

/** A lesson as one line of a prompt. */
export function lessonLine(l: Pick<Lesson, 'text' | 'appliesWhen'>): string {
  return `- ${l.text}${l.appliesWhen ? ` (applies ${l.appliesWhen.replace(/^when\s+/i, 'when ')})` : ''}`;
}

/** "Applies when" notes Orchestrator writes itself say nothing about a task. */
const boilerplateWhen = (when: string) => /^(this comes up again|agreed in meeting)\b/i.test(when.trim());
/** A lesson that says it always applies is never stale for not matching a task's words. */
const universal = (l: Pick<Lesson, 'appliesWhen'>) => /\b(always|every task|any task|all tasks|everything)\b/i.test(l.appliesWhen);

/** Ranked down: included `STALE_AFTER` task prompts in a row without once fitting the task. */
export function isStale(l: Pick<Lesson, 'appliesWhen' | 'playbook'>): boolean {
  return (l.playbook?.unmatchedStreak ?? 0) >= STALE_AFTER && !universal(l);
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Choose the lessons for one task prompt. Pure and deterministic: the same lessons and task give the
 * same lessons in the same order, whatever order they arrive in.
 *
 * `lessons` are the ones that apply at all (active, and the employee's own, their project's or the
 * company's). Each is scored: how much the lesson's wording and the task's have in common (rare words
 * count more, the "applies when" note more than the body, the task's title more than its description),
 * plus boosts for scope, for having been learned on the same kind of task, and for having been learned
 * on the same files or directories.
 * The employee's newest lessons are placed first, then the rest by score, until the budget is full.
 * A lesson that says the same as one already chosen is left out.
 */
export function selectLessons(input: { lessons: Lesson[]; employeeId: string; context: TaskContext; facts?: (lesson: Lesson) => LessonFacts | undefined; budgetChars?: number; newestOwn?: number }): Selection {
  const budget = input.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const ctx = input.context;
  const lessons = [...input.lessons].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // The task as weighted terms: where a word appears decides how much it says about the task.
  const query = new Map<string, number>();
  const surface = new Map<string, string>();
  const feed = (text: string, weight: number) => {
    for (const w of words(text)) {
      if (w.length < 2 || STOP_WORDS.has(w) || NEGATIONS.has(w)) continue;
      const t = stem(w);
      if ((query.get(t) ?? 0) < weight) query.set(t, weight);
      if (!surface.has(t)) surface.set(t, w);
    }
  };
  const files = [...new Set([...ctx.files, ...pathsIn(`${ctx.title}\n${ctx.description}\n${ctx.acceptance}`)])];
  feed(ctx.title, 1);
  feed(ctx.acceptance, 0.8);
  feed(files.join(' '), 0.8);
  feed(ctx.description, 0.6);
  feed(ctx.kind ?? '', 0.5);
  feed(ctx.projectName, 0.4);
  feed(ctx.nearFiles.map(dirOf).join(' '), 0.3);
  const taskFiles = new Set(files);
  const taskDirs = new Set([...files, ...ctx.nearFiles].map(dirOf).filter(Boolean));

  // Each lesson as weighted terms; the "applies when" note is the lesson's own statement of when it matters.
  const docs = lessons.map((l) => {
    const doc = new Map<string, number>();
    for (const t of terms(body(l.text))) doc.set(t, 1);
    if (!boilerplateWhen(l.appliesWhen)) for (const t of terms(l.appliesWhen)) doc.set(t, 1.5);
    return doc;
  });
  const idf = idfOf(docs.map((d) => d.keys()));
  // Rarity on a 0–1 scale (1: only one lesson uses the word), so scores mean the same in a small playbook and a large one.
  const rarest = Math.log((docs.length + 1) / 2) + 1;
  const averageLength = docs.reduce((n, d) => n + d.size, 0) / Math.max(1, docs.length);
  const similarityIdf = lessonIdf(lessons);

  const scored = lessons.map((lesson, i) => {
    let hit = 0;
    const matched: Array<{ term: string; weight: number }> = [];
    for (const [t, w] of docs[i]!) {
      const q = query.get(t);
      if (!q) continue;
      const weight = (w * q * idf(t)) / rarest;
      hit += weight;
      matched.push({ term: surface.get(t) ?? t, weight });
    }
    // A long lesson shares words with a task more easily than a short one: it needs somewhat more of them.
    const length = Math.min(1.5, Math.max(0.75, 0.5 + (0.5 * docs[i]!.size) / Math.max(1, averageLength)));
    const relevance = round(hit / (hit + SATURATION * length));
    matched.sort((a, b) => b.weight - a.weight || (a.term < b.term ? -1 : 1));
    const reasons: string[] = [];
    if (matched.length) reasons.push(`${relevance >= MATCH_THRESHOLD ? 'fits the task' : 'shares little with the task'}: ${matched.slice(0, 5).map((m) => m.term).join(', ')}`);
    let score = relevance;
    const own = lesson.scope === 'employee' && lesson.employeeId === input.employeeId;
    score += SCOPE_BOOST[lesson.scope];
    reasons.push(own ? 'their own lesson' : lesson.scope === 'project' ? 'project knowledge' : lesson.scope === 'company' ? 'company knowledge' : "an employee's lesson");
    const facts = input.facts?.(lesson);
    if (ctx.kind && facts?.kinds.includes(ctx.kind)) {
      score += KIND_BOOST;
      reasons.push(`learned on a ${ctx.kind} task`);
    }
    const lessonFiles = [...new Set([...(facts?.files ?? []), ...pathsIn(`${lesson.text} ${lesson.appliesWhen}`)])].sort();
    const sameFile = lessonFiles.find((f) => taskFiles.has(f));
    const sameDir = sameFile ? undefined : lessonFiles.map(dirOf).find((d) => d && taskDirs.has(d));
    if (sameFile) {
      score += SAME_FILE_BOOST;
      reasons.push(`learned on ${sameFile}`);
    } else if (sameDir) {
      score += SAME_DIR_BOOST;
      reasons.push(`learned in ${sameDir}/`);
    }
    // Knowledge the office had and that was asked for again anyway (learning/capture.ts counts these): it did not
    // reach the session that needed it, so it is put ahead of everything that merely fits. A lesson shown to help
    // (learning/outcomes.ts) is preferred among equals.
    const missed = lesson.captureMustInclude ?? 0;
    if (missed > 0) {
      score += MISSED_BOOST;
      reasons.push(`was asked about again ${missed === 1 ? 'once' : `${missed} times`} although the office knew it`);
    }
    if (lesson.proven) {
      score += PROVEN_BOOST;
      reasons.push('shown to help');
    }
    const fits = relevance >= MATCH_THRESHOLD || !!sameFile || !!sameDir || missed > 0;
    // A history of being included without fitting only counts against a lesson that does not fit this task either.
    const stale = !fits && isStale(lesson);
    if (stale) {
      score *= STALE_FACTOR;
      reasons.push(`ranked down: included ${lesson.playbook!.unmatchedStreak} task prompts in a row without fitting the task`);
    }
    return { lesson, score: round(score), relevance, matched: matched.map((m) => m.term), reasons, newestOwn: false, own, stale, fits };
  });

  const newestFirst = (a: Lesson, b: Lesson) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1);
  const ranked = [...scored].sort((a, b) => b.score - a.score || newestFirst(a.lesson, b.lesson));
  const quota = scored
    .filter((s) => s.own && !s.stale)
    .sort((a, b) => newestFirst(a.lesson, b.lesson))
    .slice(0, input.newestOwn ?? NEWEST_OWN_QUOTA);

  const chosen: typeof scored = [];
  const leftOut: Selection['leftOut'] = [];
  const seen = new Set<string>();
  let used = 0;
  const take = (s: (typeof scored)[number], viaQuota: boolean) => {
    if (seen.has(s.lesson.id)) return;
    seen.add(s.lesson.id);
    const twin = chosen.find((c) => compareLessons(c.lesson, s.lesson, similarityIdf).verdict === 'duplicate');
    if (twin) return void leftOut.push({ id: s.lesson.id, score: s.score, why: 'duplicate', of: twin.lesson.id });
    const length = lessonLine(s.lesson).length + 1;
    // The best lesson always goes in; after that nothing may push the total past the budget.
    if (chosen.length && used + length > budget) return void leftOut.push({ id: s.lesson.id, score: s.score, why: 'budget' });
    used += length;
    if (viaQuota) {
      s.newestOwn = true;
      s.reasons.push('one of their newest lessons');
    }
    chosen.push(s);
  };
  // The quota is honoured first, but never at the cost of the single best-fitting lesson.
  if (ranked[0]) take(ranked[0], quota.includes(ranked[0]));
  for (const s of quota) take(s, true);
  for (const s of ranked) take(s, false);

  chosen.sort((a, b) => b.score - a.score || newestFirst(a.lesson, b.lesson));
  return {
    chosen: chosen.map(({ lesson, score, relevance, matched, reasons, fits, newestOwn }) => ({ lesson, score, relevance, matched, reasons, fits, newestOwn })),
    leftOut,
    usedChars: used,
    budgetChars: budget,
    considered: lessons.length,
  };
}

// ─────────────────────── the office's records ─────────────────────

type Propose = (p: { kind: ImprovementKind; key: string; title: string; rationale: string; evidence: EvidenceRef[]; projectId?: string | null; employeeId?: string | null; action: ImprovementAction }) => Improvement | null;

/** A lesson about to be saved (what `Improver.saveLesson` was given, with the text tidied). */
export interface IncomingLesson {
  scope: Lesson['scope'];
  employeeId: string | null;
  projectId: string | null;
  text: string;
  appliesWhen: string;
  source: LessonSource;
  evidence: EvidenceRef[];
  status: Lesson['status'];
  authoredBy: Lesson['authoredBy'];
}

const AREA = 'playbook';
const emptyMeta = (): LessonPlaybookMeta => ({ lastIncludedAt: null, matchedCount: 0, unmatchedStreak: 0, mergedCount: 0, mergedFrom: [], mergedInto: null, promotedFrom: [], distinctFrom: [] });
const metaOf = (l: Lesson): LessonPlaybookMeta => (l.playbook ??= emptyMeta());
const sameScope = (a: Pick<Lesson, 'scope' | 'employeeId' | 'projectId'>, b: Pick<Lesson, 'scope' | 'employeeId' | 'projectId'>) => a.scope === b.scope && a.employeeId === b.employeeId && a.projectId === b.projectId;
const keptApart = (a: Lesson, b: Lesson) => !!a.playbook?.distinctFrom?.includes(b.id) || !!b.playbook?.distinctFrom?.includes(a.id);
const asEvidence = (l: Lesson): EvidenceRef => ({ kind: 'lesson', id: l.id, note: truncate(l.text, 160) });
const oldestFirst = (a: Lesson, b: Lesson) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1);

export class Playbook {
  private eng: Engine;
  private propose: Propose;
  /** What the lessons looked like when they were last tidied: nothing changed, nothing to do. */
  private tidied = '';

  constructor(eng: Engine, propose: Propose) {
    this.eng = eng;
    this.propose = propose;
  }

  private get core() {
    return this.eng.core;
  }

  // ───────────────────────── choosing lessons ────────────────────────

  /** What the task record says the task is about. A review is about the work it reviews. */
  contextOf(task: Task): TaskContext {
    const target = task.reviewOf ? this.core.tasks.get(task.reviewOf) : undefined;
    const deps = task.dependsOn.map((id) => this.core.tasks.get(id)).filter((t): t is Task => !!t);
    return {
      title: target ? `${task.title} ${target.title}` : task.title,
      description: target ? `${task.description}\n${target.description}` : task.description,
      acceptance: target ? `${task.acceptance}\n${target.acceptance}` : task.acceptance,
      kind: task.kind,
      projectName: this.core.projects.get(task.projectId)?.name ?? '',
      files: [...new Set([...task.evidence.filesChanged, ...(target?.evidence.filesChanged ?? [])])],
      nearFiles: [...new Set(deps.flatMap((d) => d.evidence.filesChanged))],
    };
  }

  /** Where a lesson came from, read from the tasks it cites. */
  private factsOf(lesson: Lesson): LessonFacts {
    const tasks = lesson.evidence.filter((e) => e.kind === 'task').map((e) => this.core.tasks.get(e.id)).filter((t): t is Task => !!t);
    return { kinds: [...new Set(tasks.map((t) => t.kind))], files: [...new Set(tasks.flatMap((t) => t.evidence.filesChanged))] };
  }

  /** The lessons a task prompt for this employee would carry, with scores and reasons. Records nothing. */
  select(employee: Employee, task: Task): Selection {
    const lessons = this.core.lessons.filter((l) => l.status === 'active' && ((l.scope === 'employee' && l.employeeId === employee.id) || (l.scope === 'project' && l.projectId === task.projectId) || l.scope === 'company'));
    return selectLessons({ lessons, employeeId: employee.id, context: this.contextOf(task), facts: (l) => this.factsOf(l), budgetChars: playbookSettings(this.core.settings).budgetChars });
  }

  /**
   * The lessons for a task prompt, or null when choosing by relevance is switched off (the caller
   * then does what it always did). With `count`, the delivery is recorded: on each lesson, on the
   * task, and as one event that says which lessons were given and why.
   */
  forTask(employee: Employee, task: Task, count: boolean): Lesson[] | null {
    if (!playbookSettings(this.core.settings).relevance) return null;
    const selection = this.select(employee, task);
    if (count && selection.chosen.length) this.recordDelivery(employee, task, selection);
    return selection.chosen.map((c) => c.lesson);
  }

  private recordDelivery(employee: Employee, task: Task, selection: Selection): void {
    const now = nowIso();
    for (const c of selection.chosen) {
      const l = c.lesson;
      const meta = metaOf(l);
      l.appliedCount++;
      meta.lastIncludedAt = now;
      if (c.fits) {
        meta.matchedCount++;
        meta.unmatchedStreak = 0;
      } else meta.unmatchedStreak++;
      this.core.put('lesson', l);
    }
    const ids = selection.chosen.map((c) => c.lesson.id);
    task.playbookLessonIds = [...new Set([...(task.playbookLessonIds ?? []), ...ids])];
    // One line in the task's own history, so the record of the task says it without anyone opening the events.
    const best = selection.chosen[0]!;
    task.history.push({ ts: now, status: task.status, note: `Prompt carried ${ids.length} playbook lesson${ids.length === 1 ? '' : 's'} (best fit: "${truncate(best.lesson.text, 70)}")`, by: 'orchestrator' });
    if (task.history.length > 100) task.history.splice(0, task.history.length - 100);
    this.core.put('task', task);
    this.core.event({
      type: 'learning.lessons_delivered',
      source: 'server',
      summary: `${employee.name} was given ${ids.length} playbook lesson${ids.length === 1 ? '' : 's'} with ${task.key}${selection.leftOut.length ? ` (${selection.leftOut.length} left out)` : ''}`,
      employeeId: employee.id,
      taskId: task.id,
      projectId: task.projectId,
      data: {
        auto: true,
        area: AREA,
        what: `Chose ${ids.length} of ${selection.considered} applicable lessons for the prompt of ${task.key}`,
        why: 'Ranked by how well each lesson fits the task (wording, scope, task kind, files), within the character budget',
        evidence: [{ kind: 'task', id: task.id, note: `${task.key} ${task.title}` }] satisfies EvidenceRef[],
        undo: null,
        quiet: true,
        key: task.key,
        attempt: task.attempts,
        budgetChars: selection.budgetChars,
        usedChars: selection.usedChars,
        considered: selection.considered,
        lessons: selection.chosen.map((c) => ({ id: c.lesson.id, score: c.score, relevance: c.relevance, matched: c.matched.slice(0, 8), reasons: c.reasons, fits: c.fits, newestOwn: c.newestOwn })),
        leftOut: selection.leftOut.slice(0, 20),
      },
    });
  }

  // ─────────────────────────── no duplicates ─────────────────────────

  /**
   * A lesson is about to be saved. If the same scope already holds it in other words, fold it in and
   * return the lesson that carries on; otherwise null (the caller saves it as a new lesson).
   */
  absorb(input: IncomingLesson): Lesson | null {
    const pool = this.core.lessons.filter((l) => l.status !== 'retired' && sameScope(l, input)).sort(oldestFirst);
    if (!pool.length) return null;
    const idf = lessonIdf([...pool, input]);
    let best: { lesson: Lesson; similarity: number } | null = null;
    for (const l of pool) {
      const c = compareLessons(l, input, idf);
      if (c.verdict === 'duplicate' && (!best || c.similarity > best.similarity)) best = { lesson: l, similarity: c.similarity };
    }
    if (!best) return null;
    return this.merge(best.lesson, { ...input, id: null, appliedCount: 0, createdAt: nowIso() }, best.similarity);
  }

  /** Fold `other` into `kept`: the clearer wording, all the evidence, the earliest date. Recorded with what is needed to take it back. */
  private merge(kept: Lesson, other: IncomingLesson & { id: string | null; appliedCount: number; createdAt: string }, similarity: number): Lesson {
    const before = { text: kept.text, appliesWhen: kept.appliesWhen, status: kept.status, createdAt: kept.createdAt, appliedCount: kept.appliedCount };
    const evidence = unionEvidence(kept.evidence, other.evidence);
    // Whose words stand: a lesson the team already works by (active, shared) is not reworded by what an employee
    // records — that would put an employee's text, unseen by anybody, under "decisions already made by the boss" in
    // everybody's prompts. Such a recording counts as evidence for the lesson as it is. An employee's own lesson, a
    // proposal that is still waiting, and anything the owner writes are reworded as before.
    const mayReword = other.authoredBy.kind === 'owner' || kept.status !== 'active' || kept.scope === 'employee';
    const wording = mayReword ? clearerText(kept, other) : kept;
    const sameWords = profile(kept.text).norm === profile(other.text).norm;
    // The very same lesson again with nothing new to cite (a repeated call): nothing to record.
    if (sameWords && !other.id && !evidence.added.length && (kept.status === 'active' || other.status !== 'active')) return kept;
    const absorbed = other.id ? this.core.lessons.get(other.id) : undefined;
    kept.text = truncate(wording.text, 400);
    kept.appliesWhen = truncate(wording.appliesWhen || kept.appliesWhen || (mayReword ? other.appliesWhen : ''), 160);
    kept.evidence = evidence.all;
    if (other.createdAt < kept.createdAt) kept.createdAt = other.createdAt;
    if (other.status === 'active') kept.status = 'active';
    kept.appliedCount += other.appliedCount;
    kept.updatedAt = nowIso();
    const meta = metaOf(kept);
    meta.mergedCount++;
    meta.mergedFrom = [...meta.mergedFrom, { ts: kept.updatedAt, lessonId: other.id, by: other.authoredBy.name, text: other.text, similarity }].slice(-MAX_MERGE_RECORDS);
    this.core.put('lesson', kept);
    const previousStatus = absorbed?.status ?? null;
    if (absorbed) {
      absorbed.status = 'retired';
      metaOf(absorbed).mergedInto = kept.id;
      absorbed.updatedAt = kept.updatedAt;
      this.core.put('lesson', absorbed);
    }
    this.core.event({
      type: 'learning.lesson_merged',
      source: 'server',
      summary: `${sameWords ? 'A lesson recorded again' : 'A lesson recorded again in other words'} was merged into the existing one: ${truncate(kept.text, 110)}`,
      employeeId: kept.employeeId ?? (other.authoredBy.kind === 'employee' ? other.authoredBy.id : null),
      projectId: kept.projectId,
      taskId: other.evidence.find((e) => e.kind === 'task')?.id ?? null,
      data: {
        auto: true,
        area: AREA,
        what: `Merged ${other.id ? `lesson ${other.id}` : `a lesson recorded by ${other.authoredBy.name}`} into lesson ${kept.id} instead of keeping both`,
        why: sameWords ? 'The same sentence in the same scope' : `Same scope, and the two share ${Math.round(similarity * 100)}% of their meaningful words, with the same polarity and the same figures (a comparison of wording, not of meaning)`,
        evidence: [asEvidence(kept), ...(absorbed ? [asEvidence(absorbed)] : []), ...evidence.added] satisfies EvidenceRef[],
        undo: {
          type: 'unmerge',
          lessonId: kept.id,
          mergedAt: kept.updatedAt,
          before,
          addedEvidence: evidence.added,
          absorbed: { id: other.id, scope: other.scope, employeeId: other.employeeId, projectId: other.projectId, text: other.text, appliesWhen: other.appliesWhen, source: other.source, evidence: other.evidence, status: other.status, authoredBy: other.authoredBy, appliedCount: other.appliedCount, createdAt: other.createdAt, previousStatus },
        },
        lessonId: kept.id,
        similarity,
        keptWording: wording === kept ? 'existing' : 'incoming',
        mergedCount: meta.mergedCount,
        quiet: sameWords,
      },
    });
    return kept;
  }

  // ───────────────────────────── promotion ───────────────────────────

  /** The project an employee's own lesson belongs to: where it was learned, else where they work. */
  private projectOf(lesson: Lesson): string | null {
    if (lesson.projectId) return lesson.projectId;
    for (const e of lesson.evidence) {
      const t = e.kind === 'task' ? this.core.tasks.get(e.id) : undefined;
      if (t) return t.projectId;
    }
    return this.core.employees.get(lesson.employeeId)?.projectId ?? null;
  }

  /** A lesson was saved as new: if a second employee of the project has now learned it too, it is the project's. */
  afterSave(lesson: Lesson): Lesson | null {
    if (lesson.scope !== 'employee') return null;
    const all = this.core.lessons.all();
    return this.promote(lesson, all, lessonIdf(all));
  }

  private promote(lesson: Lesson, all: Lesson[], idf: Idf): Lesson | null {
    if (lesson.scope !== 'employee' || lesson.status !== 'active' || !lesson.employeeId) return null;
    const projectId = this.projectOf(lesson);
    const project = projectId ? this.core.projects.get(projectId) : undefined;
    if (!project) return null;
    const same = (l: Lesson) => !keptApart(l, lesson) && compareLessons(l, lesson, idf).verdict === 'duplicate';
    // Already shared, already proposed, or already turned down by the owner (a retired project lesson): leave it.
    if (all.some((l) => ((l.scope === 'project' && l.projectId === project.id) || l.scope === 'company') && (same(l) || l.playbook?.promotedFrom?.includes(lesson.id)))) return null;
    const peers = all.filter((l) => l.id !== lesson.id && l.scope === 'employee' && l.status === 'active' && !!l.employeeId && l.employeeId !== lesson.employeeId && this.projectOf(l) === project.id && same(l)).sort(oldestFirst);
    if (!peers.length) return null;
    const group = [lesson, ...peers].sort(oldestFirst);
    const wording = group.reduce((a, b) => clearerText(a, b));
    const auto = this.core.settings.selfImprovement.autoApproveSharedLessons;
    const names = [...new Set(group.map((l) => this.core.employees.get(l.employeeId)?.name ?? l.authoredBy.name))];
    const now = nowIso();
    const promoted: Lesson = {
      id: newId().slice(0, 8),
      scope: 'project',
      employeeId: null,
      projectId: project.id,
      text: wording.text,
      appliesWhen: wording.appliesWhen || group.find((l) => l.appliesWhen)?.appliesWhen || '',
      source: 'orchestrator',
      evidence: group.reduce<EvidenceRef[]>((acc, l) => unionEvidence(acc, l.evidence).all, []),
      status: auto ? 'active' : 'proposed',
      authoredBy: { kind: 'orchestrator', id: null, name: 'Orchestrator' },
      appliedCount: 0,
      createdAt: now,
      updatedAt: now,
      playbook: { ...emptyMeta(), promotedFrom: group.map((l) => l.id) },
    };
    this.core.put('lesson', promoted);
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    this.core.event({
      type: 'learning.lesson_promoted',
      source: 'server',
      summary: `${who} have the same lesson in their own playbooks; it ${auto ? `is now a lesson for everyone on ${project.name}` : `is proposed as a lesson for everyone on ${project.name} (awaiting your approval)`}: ${truncate(promoted.text, 110)}`,
      projectId: project.id,
      data: {
        auto: true,
        area: AREA,
        what: auto ? `Made a project lesson for ${project.name} from ${group.length} employees' own lessons` : `Proposed a project lesson for ${project.name} from ${group.length} employees' own lessons`,
        why: `It was recorded separately for ${who}, who work on the same project${auto ? '; shared lessons are approved automatically in this office (setting: autoApproveSharedLessons)' : '; shared lessons wait for the owner in this office'}`,
        evidence: group.map(asEvidence) satisfies EvidenceRef[],
        undo: { type: 'retire', lessonId: promoted.id },
        lessonId: promoted.id,
        from: group.map((l) => l.id),
        proposed: !auto,
      },
    });
    if (!auto) this.eng.comms.notify({ kind: 'improvement', severity: 'info', title: `${who} learned the same thing — make it a lesson for everyone on ${project.name}?`, body: promoted.text, projectId: project.id });
    return promoted;
  }

  // ─────────────────────────── consolidation ─────────────────────────

  /** Would one employee ever be given both of these lessons? */
  private overlaps(a: Lesson, b: Lesson): boolean {
    if (a.scope === 'company' || b.scope === 'company') return true;
    if (a.scope === 'project' && b.scope === 'project') return a.projectId === b.projectId;
    if (a.scope === 'employee' && b.scope === 'employee') return a.employeeId === b.employeeId;
    const [own, shared] = a.scope === 'employee' ? [a, b] : [b, a];
    return this.core.employees.get(own.employeeId)?.projectId === shared.projectId || this.projectOf(own) === shared.projectId;
  }

  private whose(l: Lesson): string {
    if (l.scope === 'employee') return `${this.core.employees.get(l.employeeId)?.name ?? 'an employee'}'s playbook`;
    if (l.scope === 'project') return `project ${this.core.projects.get(l.projectId)?.name ?? '(unknown)'}`;
    return 'company knowledge';
  }

  /**
   * Tidy the lessons already stored: merge reworded copies within a scope, promote what two
   * employees of a project both learned, and put contradictions to the owner. Reads lesson text
   * only (no model, no session), and does nothing when there is nothing to do.
   */
  consolidate(): { merged: Lesson[]; promoted: Lesson[]; contradictions: Improvement[] } {
    const out = { merged: [] as Lesson[], promoted: [] as Lesson[], contradictions: [] as Improvement[] };
    // Everything below depends only on the lessons' text, status and scope, and on who works where.
    const signature = () => [...this.core.lessons.all().map((l) => `${l.id}:${l.status}:${l.updatedAt}`), ...this.core.employees.all().map((e) => `${e.id}:${e.projectId}`), String(this.core.settings.selfImprovement.autoApproveSharedLessons)].join('|');
    if (this.tidied === signature()) return out;
    const live = () => this.core.lessons.filter((l) => l.status !== 'retired').sort(oldestFirst);

    // 0. A lesson that was folded into another and has been brought back by hand is meant to stand on its own.
    for (const l of live()) {
      const into = l.playbook?.mergedInto ? this.core.lessons.get(l.playbook.mergedInto) : undefined;
      if (!l.playbook?.mergedInto) continue;
      l.playbook.mergedInto = null;
      if (into) {
        l.playbook.distinctFrom = [...new Set([...(l.playbook.distinctFrom ?? []), into.id])];
        metaOf(into).distinctFrom = [...new Set([...(metaOf(into).distinctFrom ?? []), l.id])];
        this.core.put('lesson', into);
      }
      this.core.put('lesson', l);
    }

    // 1. Reworded copies in the same scope: the older record carries on.
    let lessons = live();
    let idf = lessonIdf(lessons);
    const gone = new Set<string>();
    for (let i = 0; i < lessons.length; i++) {
      const kept = lessons[i]!;
      if (gone.has(kept.id)) continue;
      for (let j = i + 1; j < lessons.length; j++) {
        const other = lessons[j]!;
        if (gone.has(other.id) || !sameScope(kept, other) || keptApart(kept, other)) continue;
        const c = compareLessons(kept, other, idf);
        if (c.verdict !== 'duplicate') continue;
        gone.add(other.id);
        out.merged.push(this.merge(kept, { ...other, evidence: [...other.evidence] }, c.similarity));
      }
    }

    // 2. The same lesson in the playbooks of two employees of one project.
    if (gone.size) lessons = live();
    let all = this.core.lessons.all();
    idf = lessonIdf(all);
    for (const l of lessons) {
      const promoted = l.scope === 'employee' ? this.promote(l, all, idf) : null;
      if (!promoted) continue;
      out.promoted.push(promoted);
      all = this.core.lessons.all();
    }

    // 3. Lessons an employee could be given together that say opposite things: the owner decides.
    const active = this.core.lessons.filter((l) => l.status === 'active').sort(oldestFirst);
    idf = lessonIdf(active);
    const open = new Set<string>();
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i]!;
        const b = active[j]!;
        if (keptApart(a, b) || !this.overlaps(a, b)) continue;
        const c = compareLessons(a, b, idf);
        if (c.verdict !== 'contradiction') continue;
        const key = `playbook-contradiction:${[a.id, b.id].sort().join(':')}`;
        open.add(key);
        const how = c.reason === 'polarity' ? 'one tells employees to do what the other tells them not to' : c.reason === 'numbers' ? 'they read the same but give different figures' : 'they are two of your decisions on what reads as the same question';
        const imp = this.propose({
          kind: 'playbook_contradiction',
          key,
          title: c.reason === 'decision' ? 'Two recorded decisions look like the same question' : 'Two lessons contradict each other',
          rationale: `“${truncate(a.text, 220)}” (${this.whose(a)}) and “${truncate(b.text, 220)}” (${this.whose(b)}) share ${Math.round(c.similarity * 100)}% of their meaningful words, and ${how}. Both are active, so an employee can be given both. This is a comparison of wording, not of meaning: if they do conflict, retire or edit the one that is wrong; if they do not, dismiss this.`,
          evidence: [asEvidence(a), asEvidence(b)],
          projectId: a.projectId ?? b.projectId ?? null,
          employeeId: a.employeeId ?? b.employeeId ?? null,
          action: { type: 'advice' },
        });
        if (!imp) continue;
        out.contradictions.push(imp);
        this.core.event({
          type: 'learning.contradiction_flagged',
          source: 'server',
          summary: `Two lessons that may contradict each other were put to the owner`,
          projectId: imp.projectId,
          employeeId: imp.employeeId,
          data: { auto: true, area: AREA, what: `Proposed that the owner looks at lessons ${a.id} and ${b.id}`, why: `High similarity (${c.similarity}) with ${c.reason === 'polarity' ? 'opposite polarity' : c.reason === 'numbers' ? 'different figures' : 'different wording of a recorded decision'}`, evidence: [asEvidence(a), asEvidence(b)] satisfies EvidenceRef[], undo: null, improvementId: imp.id, reason: c.reason, similarity: c.similarity, quiet: true },
        });
      }
    }

    // 4. A flagged pair the owner has since dealt with (one retired or reworded) no longer needs an answer.
    for (const imp of this.core.improvements.filter((i) => i.kind === 'playbook_contradiction' && i.status === 'proposed' && !open.has(i.dedupeKey))) {
      imp.status = 'applied';
      imp.decidedAt = nowIso();
      this.core.put('improvement', imp);
      this.core.event({
        type: 'learning.contradiction_closed',
        source: 'server',
        summary: `Closed: ${imp.title} (the lessons no longer conflict)`,
        projectId: imp.projectId,
        employeeId: imp.employeeId,
        data: { auto: true, area: AREA, what: `Closed suggestion ${imp.id}`, why: 'One of the two lessons was retired or changed, so the pair is no longer active and alike', evidence: imp.evidence, undo: null, improvementId: imp.id, quiet: true },
      });
    }
    this.tidied = signature();
    return out;
  }

  // ────────────────────────────── undo ───────────────────────────────

  /** Take back an automatic merge or promotion, by the id of the event that recorded it. */
  revert(eventId: string, actor = 'owner'): { reverted: string; lessonIds: string[] } {
    const find = (types: string[]): OrchestratorEvent[] => this.core.store.queryEvents({ types, limit: 2000 });
    const ev = find(['learning.lesson_merged', 'learning.lesson_promoted']).find((e) => e.id === eventId);
    if (!ev) throw new EngineError('there is no merge or promotion with that id to undo', 404);
    if (find(['learning.reverted']).some((e) => e.data.revertedEventId === eventId)) throw new EngineError('this was already undone', 409);
    const undo = ev.data.undo as any;
    const lesson = this.core.lessons.require(String(undo?.lessonId ?? ''));
    const touched = [lesson.id];
    if (undo.type === 'retire') {
      lesson.status = 'retired';
      lesson.updatedAt = nowIso();
      this.core.put('lesson', lesson);
    } else if (undo.type === 'unmerge') {
      const a = undo.absorbed as IncomingLesson & { id: string | null; appliedCount: number; createdAt: string; previousStatus: Lesson['status'] | null };
      const added = (undo.addedEvidence ?? []) as EvidenceRef[];
      // Only what this merge brought is taken back: a wording, date or status that came from a later merge or from the owner stays.
      if (lesson.text === truncate(a.text, 400)) Object.assign(lesson, { text: undo.before.text, appliesWhen: undo.before.appliesWhen });
      if (lesson.createdAt === a.createdAt) lesson.createdAt = undo.before.createdAt;
      if (lesson.status === 'active' && a.status === 'active' && undo.before.status === 'proposed') lesson.status = 'proposed';
      lesson.appliedCount = Math.max(0, lesson.appliedCount - a.appliedCount);
      lesson.evidence = lesson.evidence.filter((e) => !added.some((x) => x.kind === e.kind && x.id === e.id));
      const meta = metaOf(lesson);
      meta.mergedCount = Math.max(0, meta.mergedCount - 1);
      const at = meta.mergedFrom.findIndex((m) => m.ts === undo.mergedAt && m.lessonId === a.id && m.text === a.text);
      if (at >= 0) meta.mergedFrom.splice(at, 1);
      // The lesson that was folded in stands on its own again, and the two are not merged a second time.
      let other = a.id ? this.core.lessons.get(a.id) : undefined;
      if (other) {
        other.status = a.previousStatus ?? 'active';
        metaOf(other).mergedInto = null;
      } else {
        other = { id: newId().slice(0, 8), scope: a.scope, employeeId: a.employeeId, projectId: a.projectId, text: truncate(a.text, 400), appliesWhen: truncate(a.appliesWhen ?? '', 160), source: a.source, evidence: a.evidence ?? [], status: a.status, authoredBy: a.authoredBy, appliedCount: 0, createdAt: a.createdAt, updatedAt: nowIso(), playbook: emptyMeta() };
      }
      other.updatedAt = nowIso();
      metaOf(other).distinctFrom = [...new Set([...(metaOf(other).distinctFrom ?? []), lesson.id])];
      meta.distinctFrom = [...new Set([...(meta.distinctFrom ?? []), other.id])];
      lesson.updatedAt = nowIso();
      this.core.put('lesson', lesson);
      this.core.put('lesson', other);
      touched.push(other.id);
    } else throw new EngineError('this event cannot be undone');
    this.core.audit(actor, 'learning.reverted', eventId, { type: ev.type, lessonIds: touched });
    this.core.event({
      type: 'learning.reverted',
      source: 'owner',
      summary: undo.type === 'retire' ? `Undone: the promoted lesson was retired (${truncate(lesson.text, 90)})` : `Undone: the two merged lessons are separate again (${truncate(lesson.text, 90)})`,
      employeeId: ev.employeeId,
      projectId: ev.projectId,
      data: { auto: false, area: AREA, what: `Reverted ${ev.type} ${eventId}`, why: `Asked for by ${actor}`, evidence: touched.map((id) => asEvidence(this.core.lessons.require(id))) satisfies EvidenceRef[], undo: null, revertedEventId: eventId, lessonIds: touched },
    });
    return { reverted: ev.type, lessonIds: touched };
  }
}
