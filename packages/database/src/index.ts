import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { AuditEntry, NewEvent, OrchestratorEvent } from '@orchestrator/contracts';
import { newId, nowIso, redactDeep, redactSecrets } from '@orchestrator/contracts';

/**
 * Persistence for a local Orchestrator installation, on Node's built-in
 * SQLite. Entities are stored as JSON documents keyed by (kind, id) and kept
 * in an in-memory cache — an office has hundreds of rows, not millions — while
 * the event store, audit log and credentials are proper indexed tables.
 *
 * `StorageDriver` is the seam for a PostgreSQL backend in larger deployments.
 */
export interface StorageDriver {
  loadDocs(): Array<{ kind: string; id: string; data: string }>;
  putDoc(kind: string, id: string, data: string): void;
  deleteDoc(kind: string, id: string): void;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE docs (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    host_id TEXT,
    session_id TEXT,
    employee_id TEXT,
    task_id TEXT,
    project_id TEXT,
    correlation_id TEXT,
    summary TEXT NOT NULL,
    source TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX events_ts ON events (ts);
  CREATE INDEX events_employee ON events (employee_id, seq);
  CREATE INDEX events_task ON events (task_id, seq);
  CREATE INDEX events_session ON events (session_id, seq);
  CREATE INDEX events_type ON events (type, seq);
  CREATE TABLE processed (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL
  );
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE credentials (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ref_id TEXT,
    label TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX credentials_ref ON credentials (kind, ref_id);
  CREATE TABLE audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX audit_ts ON audit (ts);
  `,
];

export type CredentialKind = 'owner' | 'enrollment' | 'host' | 'mcp' | 'guest';

export interface CredentialRecord {
  kind: CredentialKind;
  refId: string | null;
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  revokedAt: string | null;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateToken(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

/** Where a collection writes its documents through to. */
export interface DocSink {
  _putDoc(kind: string, id: string, data: string): void;
  _deleteDoc(kind: string, id: string): void;
}

/**
 * The persistence contract the engine is written against. `Store` (SQLite) and
 * `PgStore` (PostgreSQL) both implement it.
 */
export interface Storage {
  readonly file: string;
  readonly isClosed: boolean;
  col<T extends { id: string }>(kind: string): Collection<T>;
  kvGet<T>(key: string, fallback: T): T;
  kvSet(key: string, value: unknown): void;
  nextCounter(key: string): number;
  appendEvent(e: NewEvent): OrchestratorEvent | null;
  queryEvents(q?: EventQuery): OrchestratorEvent[];
  markProcessed(id: string): boolean;
  pruneProcessed(olderThanDays?: number): void;
  addCredential(kind: CredentialKind, token: string, opts?: { refId?: string | null; label?: string | null; ttlMs?: number }): void;
  checkCredential(kind: CredentialKind, token: string | null | undefined): CredentialRecord | null;
  markCredentialUsed(token: string): void;
  revokeCredential(token: string): void;
  revokeCredentialsFor(kind: CredentialKind, refId: string): void;
  /** Revoke the credentials of one owner whose label starts with a prefix (a member's sign-in sessions, not their app's own). */
  revokeCredentialsWhere(kind: CredentialKind, refId: string, labelPrefix: string): void;
  listCredentials(kind: CredentialKind): Array<CredentialRecord & { hashPrefix: string }>;
  audit(actor: string, action: string, target: string, detail?: Record<string, unknown>): AuditEntry;
  recentAudit(limit?: number): AuditEntry[];
  close(): void | Promise<void>;
}

export interface EventQuery {
  employeeId?: string;
  taskId?: string;
  sessionId?: string;
  projectId?: string;
  types?: string[];
  excludeTypes?: string[];
  since?: string;
  beforeSeq?: number;
  limit?: number;
  /** Only events whose type starts with this, e.g. "learning." */
  typePrefix?: string;
}

export class Collection<T extends { id: string }> {
  private items = new Map<string, T>();
  readonly kind: string;
  private store: DocSink;

  constructor(store: DocSink, kind: string) {
    this.store = store;
    this.kind = kind;
  }

  /** @internal used while loading */
  _load(id: string, value: T): void {
    this.items.set(id, value);
  }

  get(id: string | null | undefined): T | undefined {
    return id ? this.items.get(id) : undefined;
  }

  require(id: string): T {
    const v = this.items.get(id);
    if (!v) throw new NotFoundError(`${this.kind} ${id} not found`);
    return v;
  }

  all(): T[] {
    return [...this.items.values()];
  }

  filter(fn: (v: T) => boolean): T[] {
    return this.all().filter(fn);
  }

  find(fn: (v: T) => boolean): T | undefined {
    for (const v of this.items.values()) if (fn(v)) return v;
    return undefined;
  }

  get size(): number {
    return this.items.size;
  }

  put(value: T): T {
    this.items.set(value.id, value);
    this.store._putDoc(this.kind, value.id, JSON.stringify(value));
    return value;
  }

  delete(id: string): boolean {
    const had = this.items.delete(id);
    if (had) this.store._deleteDoc(this.kind, id);
    return had;
  }
}

export class NotFoundError extends Error {}

export class Store implements Storage {
  readonly db: DatabaseSync;
  private collections = new Map<string, Collection<any>>();
  private stmt: Record<string, StatementSync> = {};
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    // The wait for a lock comes first: everything after it — switching to WAL included — then waits its turn instead
    // of failing at once with "database is locked" when a process that is just ending still holds the file (an
    // office restarted right after a deploy starts while the old one is closing).
    this.db.exec('PRAGMA busy_timeout = 15000;');
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    if (file !== ':memory:') {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* best effort */
      }
    }
    this.migrate();
    this.prepare();
    for (const row of this.db.prepare('SELECT kind, id, data FROM docs').all() as Array<{ kind: string; id: string; data: string }>) {
      this.col<any>(row.kind)._load(row.id, JSON.parse(row.data));
    }
  }

  private migrate(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  private prepare(): void {
    const p = (sql: string) => this.db.prepare(sql);
    this.stmt = {
      putDoc: p('INSERT INTO docs (kind, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'),
      delDoc: p('DELETE FROM docs WHERE kind = ? AND id = ?'),
      insEvent: p(
        'INSERT OR IGNORE INTO events (id, ts, type, host_id, session_id, employee_id, task_id, project_id, correlation_id, summary, source, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      processed: p('INSERT OR IGNORE INTO processed (id, ts) VALUES (?, ?)'),
      kvGet: p('SELECT value FROM kv WHERE key = ?'),
      kvSet: p('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      credAdd: p('INSERT OR REPLACE INTO credentials (hash, kind, ref_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
      credGet: p('SELECT kind, ref_id, label, created_at, expires_at, used_at, revoked_at FROM credentials WHERE hash = ?'),
      credUse: p('UPDATE credentials SET used_at = ? WHERE hash = ?'),
      credRevokeHash: p('UPDATE credentials SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL'),
      credRevokeRef: p('UPDATE credentials SET revoked_at = ? WHERE kind = ? AND ref_id = ? AND revoked_at IS NULL'),
      audit: p('INSERT INTO audit (id, ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)'),
    };
  }

  private closed = false;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ───────────── documents ─────────────

  col<T extends { id: string }>(kind: string): Collection<T> {
    let c = this.collections.get(kind);
    if (!c) {
      c = new Collection<T>(this, kind);
      this.collections.set(kind, c);
    }
    return c as Collection<T>;
  }

  /** @internal */
  _putDoc(kind: string, id: string, data: string): void {
    if (this.closed) return;
    this.stmt.putDoc!.run(kind, id, data, nowIso());
  }

  /** @internal */
  _deleteDoc(kind: string, id: string): void {
    if (this.closed) return;
    this.stmt.delDoc!.run(kind, id);
  }

  // ───────────── key/value ─────────────

  kvGet<T>(key: string, fallback: T): T {
    if (this.closed) return fallback;
    const row = this.stmt.kvGet!.get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  kvSet(key: string, value: unknown): void {
    if (this.closed) return;
    this.stmt.kvSet!.run(key, JSON.stringify(value));
  }

  nextCounter(key: string): number {
    const n = this.kvGet<number>(`counter:${key}`, 0) + 1;
    this.kvSet(`counter:${key}`, n);
    return n;
  }

  // ───────────── events ─────────────

  /**
   * Append to the event store. Returns null when an event with the same id
   * was already stored, which makes redelivery from hosts harmless.
   */
  appendEvent(e: NewEvent): OrchestratorEvent | null {
    // Late timers may fire while the server is shutting down; they must not throw.
    if (this.closed) return null;
    const id = e.id ?? newId();
    const ts = e.ts ?? nowIso();
    const summary = redactSecrets(e.summary);
    const data = redactDeep(e.data ?? {});
    const res = this.stmt.insEvent!.run(
      id,
      ts,
      e.type,
      e.hostId ?? null,
      e.sessionId ?? null,
      e.employeeId ?? null,
      e.taskId ?? null,
      e.projectId ?? null,
      e.correlationId ?? null,
      summary,
      JSON.stringify(e.source),
      JSON.stringify(data),
    );
    if (res.changes === 0) return null;
    return { ...e, id, ts, seq: Number(res.lastInsertRowid), summary, data } as OrchestratorEvent;
  }

  private rowToEvent(r: any): OrchestratorEvent {
    return {
      seq: r.seq,
      id: r.id,
      ts: r.ts,
      type: r.type,
      hostId: r.host_id,
      sessionId: r.session_id,
      employeeId: r.employee_id,
      taskId: r.task_id,
      projectId: r.project_id,
      correlationId: r.correlation_id,
      summary: r.summary,
      source: JSON.parse(r.source),
      data: JSON.parse(r.data),
    };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  queryEvents(q: EventQuery = {}): OrchestratorEvent[] {
    if (this.closed) return [];
    const where: string[] = [];
    const args: any[] = [];
    if (q.employeeId) (where.push('employee_id = ?'), args.push(q.employeeId));
    if (q.taskId) (where.push('task_id = ?'), args.push(q.taskId));
    if (q.sessionId) (where.push('session_id = ?'), args.push(q.sessionId));
    if (q.projectId) (where.push('project_id = ?'), args.push(q.projectId));
    if (q.since) (where.push('ts >= ?'), args.push(q.since));
    if (q.beforeSeq) (where.push('seq < ?'), args.push(q.beforeSeq));
    if (q.types?.length) (where.push(`type IN (${q.types.map(() => '?').join(',')})`), args.push(...q.types));
    if (q.excludeTypes?.length) (where.push(`type NOT IN (${q.excludeTypes.map(() => '?').join(',')})`), args.push(...q.excludeTypes));
    if (q.typePrefix) (where.push('substr(type, 1, ?) = ?'), args.push(q.typePrefix.length, q.typePrefix));
    const limit = Math.max(1, Math.min(2000, q.limit ?? 200));
    const rows = this.db.prepare(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ${limit}`).all(...args);
    return rows.map((r) => this.rowToEvent(r)).reverse();
  }

  /** True the first time an id is seen; false for a redelivery. */
  markProcessed(id: string): boolean {
    if (this.closed) return false;
    return this.stmt.processed!.run(id, nowIso()).changes > 0;
  }

  pruneProcessed(olderThanDays = 7): void {
    if (this.closed) return;
    this.db.prepare('DELETE FROM processed WHERE ts < ?').run(new Date(Date.now() - olderThanDays * 86400_000).toISOString());
  }

  // ───────────── credentials ─────────────

  /** Only hashes are stored; the plaintext token is shown to the operator once. */
  addCredential(kind: CredentialKind, token: string, opts: { refId?: string | null; label?: string | null; ttlMs?: number } = {}): void {
    this.stmt.credAdd!.run(hashToken(token), kind, opts.refId ?? null, opts.label ?? null, nowIso(), opts.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : null);
  }

  /** Returns the credential when the token is valid, unexpired and not revoked. */
  checkCredential(kind: CredentialKind, token: string | null | undefined): CredentialRecord | null {
    if (!token || this.closed) return null;
    const r = this.stmt.credGet!.get(hashToken(token)) as any;
    if (!r || r.kind !== kind || r.revoked_at) return null;
    if (r.expires_at && r.expires_at < nowIso()) return null;
    return { kind: r.kind, refId: r.ref_id, label: r.label, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, revokedAt: r.revoked_at };
  }

  markCredentialUsed(token: string): void {
    this.stmt.credUse!.run(nowIso(), hashToken(token));
  }

  revokeCredential(token: string): void {
    this.stmt.credRevokeHash!.run(nowIso(), hashToken(token));
  }

  revokeCredentialsFor(kind: CredentialKind, refId: string): void {
    this.stmt.credRevokeRef!.run(nowIso(), kind, refId);
  }

  revokeCredentialsWhere(kind: CredentialKind, refId: string, labelPrefix: string): void {
    this.db.prepare("UPDATE credentials SET revoked_at = ? WHERE kind = ? AND ref_id = ? AND revoked_at IS NULL AND substr(label, 1, ?) = ?").run(nowIso(), kind, refId, labelPrefix.length, labelPrefix);
  }

  listCredentials(kind: CredentialKind): Array<CredentialRecord & { hashPrefix: string }> {
    const rows = this.db.prepare('SELECT * FROM credentials WHERE kind = ? ORDER BY created_at DESC').all(kind) as any[];
    return rows.map((r) => ({ kind: r.kind, refId: r.ref_id, label: r.label, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, revokedAt: r.revoked_at, hashPrefix: String(r.hash).slice(0, 10) }));
  }

  // ───────────── audit ─────────────

  audit(actor: string, action: string, target: string, detail: Record<string, unknown> = {}): AuditEntry {
    const entry: AuditEntry = { id: newId(), ts: nowIso(), actor, action, target, detail: redactDeep(detail) };
    if (this.closed) return entry;
    this.stmt.audit!.run(entry.id, entry.ts, actor, action, target, JSON.stringify(entry.detail));
    return entry;
  }

  recentAudit(limit = 200): AuditEntry[] {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(Math.min(2000, limit)) as any[];
    return rows.map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, target: r.target, detail: JSON.parse(r.detail) }));
  }
}

export { PgStore } from './postgres.ts';
