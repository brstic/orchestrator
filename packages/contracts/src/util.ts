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

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*)\s*([=:])\s*("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{6,})/gi;

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
};
