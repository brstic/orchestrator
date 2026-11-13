/** Small helpers that are safe in both Node and the browser. */

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function shortId(n = 8): string {
  return newId().replace(/-/g, '').slice(0, n);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(s: string, max = 40): string {
  const out = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return out || 'x';
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The text without the characters of `chars` at its end. Use this instead of `text.replace(/[…]+$/, '')` on text
 * somebody else can shape: that pattern is tried from every character of every run and takes time with the square of
 * the run's length (200,000 full stops in the middle of a text: a quarter of a minute); this walks back from the end.
 */
export function stripEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return end === text.length ? text : text.slice(0, end);
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}

// These run over every event the office keeps — text a session can shape — on the office's one thread: each takes
// time in step with the text's length (parts have a longest length; a name begins where a word begins). Timed on text
// built to be slow in `test/util.test.ts`; see DECISIONS.md, "Patterns that read other people's text…".
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,8000}\.[A-Za-z0-9_-]{10,8000}\.[A-Za-z0-9_-]{5,8000}\b/g,
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g,
];

const SECRET_ASSIGNMENT = /(?<![A-Za-z0-9_])([A-Za-z0-9_]{0,64}(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]{0,64})\s*([=:])\s*("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{6,})/gi;

/**
 * Redacts likely secrets before text is persisted in the event store, audit
 * log or notifications. Live terminal streams are never persisted, so they are
 * not run through this.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  out = out.replace(SECRET_ASSIGNMENT, (_m, k: string, sep: string) => `${k}${sep}[REDACTED]`);
  return out;
}

/** Whether the text holds a value in one of the well-known credential formats (stricter than what `redactSecrets` hides). */
export function containsKnownSecret(text: string): boolean {
  return !!text && SECRET_PATTERNS.some((re) => new RegExp(re.source, re.flags.replace('g', '')).test(text));
}

export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 6) return value;
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|token|password|passwd|api_?key|private_?key|credential/i.test(k) && typeof v === 'string') out[k] = '[REDACTED]';
      else out[k] = redactDeep(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Node's Buffer when running under Node; undefined in the browser. */
const NodeBuffer: any = (globalThis as any).Buffer;

export function b64encode(bytes: Uint8Array): string {
  if (NodeBuffer) return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  if (NodeBuffer) return new Uint8Array(NodeBuffer.from(s, 'base64'));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Marker embedded in prompts typed into a terminal so delivery can be confirmed by a hook. */
export function correlationMarker(kind: 'TASK' | 'MSG' | 'ANSWER' | 'MEETING' | 'REVIEW' | 'REPORT' | 'RETRO' | 'ROUND', id: string): string {
  return `[ORCH:${kind}:${id}]`;
}

export function parseCorrelationMarkers(text: string): Array<{ kind: string; id: string }> {
  const out: Array<{ kind: string; id: string }> = [];
  const re = /\[ORCH:([A-Z]+):([A-Za-z0-9_-]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ kind: m[1]!, id: m[2]! });
  return out;
}

export const ACTIVITY_LABEL: Record<string, string> = {
  // No session is running: they are asleep at their desk until someone talks to them or gives them work.
  offline: 'SLEEPING',
  unknown: 'UNKNOWN',
  idle: 'AVAILABLE',
  thinking: 'THINKING',
  reading: 'READING FILES',
  coding: 'CODING',
  testing: 'RUNNING TESTS',
  debugging: 'DEBUGGING',
  running_command: 'RUNNING COMMAND',
  researching: 'RESEARCHING',
  planning: 'PLANNING',
  reviewing: 'REVIEWING',
  delegating: 'DELEGATING',
  waiting_answer: '? NEEDS A DECISION',
  needs_approval: '? NEEDS APPROVAL',
  blocked: '! BLOCKED',
  waiting_input: 'WAITING',
  task_complete: '✓ TASK COMPLETED',
  meeting: 'IN MEETING',
  paused: 'PAUSED',
  waiting_command: '⏳ COMMAND RUNNING',
};

/** The models an employee can be put on by name. Aliases, so "Opus" stays the newest Opus without anyone editing a profile. */
export const MODEL_CHOICES: Array<{ value: string; label: string; what: string }> = [
  { value: 'fable', label: 'Fable', what: 'the most capable; uses the most of the account' },
  { value: 'opus', label: 'Opus', what: 'very capable' },
  { value: 'sonnet', label: 'Sonnet', what: 'fast and capable; the everyday choice' },
  { value: 'haiku', label: 'Haiku', what: 'the fastest and lightest' },
];

/** `claude --effort`: how hard the model works on each turn. More effort is slower and uses more of the account. */
export const EFFORT_CHOICES: Array<{ value: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

/**
 * The answers a question proposes in its own words — "A) … B) … C) …" — as choices to click. Employees are asked to
 * give a question's choices separately, and a model does not always do it: it writes them into the question. Read out
 * of the text, they can still be answered with one click instead of by typing "A".
 *
 * Only letters that follow each other from A, each written `A)` (or `(A)`) at the start of a line or after a space;
 * a numbered list ("1. … 2. …") is an enumeration, not a set of answers, and is left alone. A choice's label is its
 * letter and the head of its text; the rest of it is the description. The last choice ends with its sentence — what
 * follows it is the question going on. Nothing is returned unless there are at least two.
 */
export function optionsIn(text: unknown): Array<{ label: string; description?: string }> {
  if (typeof text !== 'string' || text.length > 20_000) return [];
  const marks: Array<{ letter: string; at: number; from: number }> = [];
  const re = /(^|\s)\(?([A-H])\)[ \t]+(?=\S)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const letter = m[2]!;
    const want = String.fromCharCode(65 + marks.length);
    if (letter === want) marks.push({ letter, at: m.index + m[1]!.length, from: m.index + m[0].length });
    else if (letter === 'A' && marks.length < 2) {
      // (An "A)" that led nowhere — a part of a sentence — and now the real list begins.)
      marks.length = 0;
      marks.push({ letter, at: m.index + m[1]!.length, from: m.index + m[0].length });
    }
  }
  if (marks.length < 2) return [];
  const out: Array<{ label: string; description?: string }> = [];
  for (const [i, mark] of marks.entries()) {
    let body = text.slice(mark.from, i + 1 < marks.length ? marks[i + 1]!.at : text.length);
    if (i + 1 === marks.length) {
      // Up to the end of its paragraph, and of its first sentence in it.
      const para = body.search(/\n\s*\n/);
      if (para !== -1) body = body.slice(0, para);
      let depth = 0;
      for (let k = 0; k < body.length; k++) {
        const ch = body[k]!;
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if ((ch === '.' || ch === '!' || ch === '?') && depth === 0 && k > 8 && /^\s+\p{Lu}/u.test(body.slice(k + 1, k + 6))) {
          body = body.slice(0, k + 1);
          break;
        }
      }
    }
    body = body.replace(/\s+/g, ' ').trim();
    if (!body || body.length > 1500) return [];
    // The head: up to a colon or a dash that comes early; otherwise up to the first comma or bracket; otherwise cut.
    const cut = (() => {
      const colon = body.search(/:\s| [—–-] /);
      if (colon >= 2 && colon <= 110) return colon;
      const stop = body.search(/[.;]\s/);
      if (stop >= 2 && stop <= 110) return stop;
      return body.length <= 110 ? body.length : -1;
    })();
    const head = (cut === -1 ? `${body.slice(0, 100).replace(/\s+\S*$/, '')}…` : body.slice(0, cut)).replace(/[\s.,;:]+$/, '');
    const rest = cut === -1 ? body : body.slice(cut).replace(/^[\s:—–.;-]+/, '');
    out.push({ label: `${mark.letter}) ${head}`, ...(rest && rest !== head ? { description: rest.length > 600 ? `${rest.slice(0, 597)}…` : rest } : {}) });
  }
  return out;
}
