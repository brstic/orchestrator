import type { AuditEntry, NewEvent, OrchestratorEvent } from '@orchestrator/contracts';
import { newId, nowIso, redactDeep, redactSecrets } from '@orchestrator/contracts';
import { Collection, hashToken, type CredentialKind, type CredentialRecord, type EventQuery, type Storage } from './index.ts';

/**
 * PostgreSQL storage for larger deployments.
 *
 * The engine is synchronous and reads constantly, so — exactly like the SQLite
 * store — state is held in memory and every change is written through. Here
 * the write-through is an ordered queue on one connection: writes are applied
 * to Postgres in the order they happened, retried if the database is briefly
 * unavailable, and `flush()` / `close()` wait for the queue to drain.
 *
 * One Orchestrator server owns a database at a time (an advisory lock enforces
 * it); this is durability and operability, not horizontal scaling.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orch_docs (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS orch_events (
  seq BIGINT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  ts TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL,
  host_id TEXT,
  session_id TEXT,
  employee_id TEXT,
  task_id TEXT,
  project_id TEXT,
  correlation_id TEXT,
  summary TEXT NOT NULL,
  source JSONB NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS orch_events_employee ON orch_events (employee_id, seq);
CREATE INDEX IF NOT EXISTS orch_events_task ON orch_events (task_id, seq);
CREATE INDEX IF NOT EXISTS orch_events_type ON orch_events (type, seq);
CREATE TABLE IF NOT EXISTS orch_processed (id TEXT PRIMARY KEY, ts TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS orch_kv (key TEXT PRIMARY KEY, value JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS orch_credentials (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS orch_audit (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail JSONB NOT NULL
);
`;

interface CredRow extends CredentialRecord {
  hash: string;
}

interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  end(): Promise<void>;
  on(event: 'error', fn: (e: Error) => void): void;
}

export interface PgStoreOptions {
  /** How many of the most recent events are kept in memory for queries (older ones stay in the database). */
  eventWindow?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

export class PgStore implements Storage {
  readonly file: string;
  private client: PgClient;
  private collections = new Map<string, Collection<any>>();
  private kv = new Map<string, unknown>();
  private creds = new Map<string, CredRow>();
  private processed = new Map<string, number>();
  private events: OrchestratorEvent[] = [];
  private eventIds = new Set<string>();
  private auditLog: AuditEntry[] = [];
  private lastSeq = 0;
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private window: number;
  private log: NonNullable<PgStoreOptions['log']>;

  private constructor(url: string, client: PgClient, opts: PgStoreOptions) {
    this.file = url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
    this.client = client;
    this.window = opts.eventWindow ?? 100_000;
    this.log = opts.log ?? (() => undefined);
  }

  /** Connect, create the schema if needed, take ownership of the database and load state. */
  static async open(url: string, opts: PgStoreOptions = {}): Promise<PgStore> {
    const pg: any = await import('pg');
    const Client = pg.Client ?? pg.default?.Client;
    const client: PgClient = new Client({ connectionString: url, application_name: 'orchestrator' });
    await (client as any).connect();
    const store = new PgStore(url, client, opts);
    client.on('error', (e) => store.log('error', `postgres connection error: ${e.message}`));
    const lock = await client.query('SELECT pg_try_advisory_lock(727274) AS ok');
    if (!lock.rows[0]?.ok) {
      await client.end();
      throw new Error('another Orchestrator server is already using this database');
    }
    await client.query(SCHEMA);
    for (const r of (await client.query('SELECT kind, id, data FROM orch_docs')).rows) store.col<any>(r.kind)._load(r.id, r.data);
    for (const r of (await client.query('SELECT key, value FROM orch_kv')).rows) store.kv.set(r.key, r.value);
    for (const r of (await client.query('SELECT * FROM orch_credentials')).rows) {
      store.creds.set(r.hash, { hash: r.hash, kind: r.kind, refId: r.ref_id, label: r.label, createdAt: iso(r.created_at)!, expiresAt: iso(r.expires_at), usedAt: iso(r.used_at), revokedAt: iso(r.revoked_at) });
    }
    for (const r of (await client.query("SELECT id, ts FROM orch_processed WHERE ts > now() - interval '8 days'")).rows) store.processed.set(r.id, new Date(r.ts).getTime());
    const events = await client.query('SELECT * FROM (SELECT * FROM orch_events ORDER BY seq DESC LIMIT $1) t ORDER BY seq ASC', [store.window]);
    for (const r of events.rows) {
      const e = store.rowToEvent(r);
      store.events.push(e);
      store.eventIds.add(e.id);
    }
    store.lastSeq = Number((await client.query('SELECT COALESCE(MAX(seq), 0) AS m FROM orch_events')).rows[0].m);
    for (const r of (await client.query('SELECT * FROM (SELECT * FROM orch_audit ORDER BY seq DESC LIMIT 2000) t ORDER BY seq ASC')).rows) {
      store.auditLog.push({ id: r.id, ts: iso(r.ts)!, actor: r.actor, action: r.action, target: r.target, detail: r.detail });
    }
    return store;
  }

  private rowToEvent(r: any): OrchestratorEvent {
    return { seq: Number(r.seq), id: r.id, ts: iso(r.ts)!, type: r.type, hostId: r.host_id, sessionId: r.session_id, employeeId: r.employee_id, taskId: r.task_id, projectId: r.project_id, correlationId: r.correlation_id, summary: r.summary, source: r.source, data: r.data };
  }

  // ───────────── ordered write-through ─────────────

  private write(text: string, params: unknown[]): void {
    if (this.closed) return;
    this.pending++;
    this.chain = this.chain.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.client.query(text, params);
          break;
        } catch (e) {
          const msg = (e as Error).message;
          // A statement the database rejects will never succeed; a lost connection might.
          const transient = /ECONN|terminat|timeout|not queryable|connection/i.test(msg);
          if (!transient || attempt >= 20 || this.closed) {
            this.log('error', `postgres write failed (${text.slice(0, 60)}…): ${msg}`);
            break;
          }
          await new Promise((r) => setTimeout(r, Math.min(5000, 200 * (attempt + 1))));
        }
      }
      this.pending--;
    });
  }

  /** Resolves once every change made so far is in Postgres. */
  flush(): Promise<void> {
    return this.chain;
  }

  get pendingWrites(): number {
    return this.pending;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Changes made while the earlier ones are still being written are waited for too: the office keeps recording
    // (a turn that ends, a host going offline) until the moment it stops, and none of that may be dropped.
    for (let seen = this.chain; ; seen = this.chain) {
      await seen;
      if (seen === this.chain) break;
    }
    this.closed = true;
    await this.client.end().catch(() => undefined);
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
    this.write('INSERT INTO orch_docs (kind, id, data, updated_at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [kind, id, data]);
  }

  /** @internal */
  _deleteDoc(kind: string, id: string): void {
    this.write('DELETE FROM orch_docs WHERE kind = $1 AND id = $2', [kind, id]);
  }

  // ───────────── key/value ─────────────

  kvGet<T>(key: string, fallback: T): T {
    return this.kv.has(key) ? (this.kv.get(key) as T) : fallback;
  }

  kvSet(key: string, value: unknown): void {
    if (this.closed) return;
    // Store a copy: callers keep mutating the object they passed in.
    const copy = JSON.parse(JSON.stringify(value));
    this.kv.set(key, copy);
    this.write('INSERT INTO orch_kv (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(copy)]);
  }

  nextCounter(key: string): number {
    const n = this.kvGet<number>(`counter:${key}`, 0) + 1;
    this.kvSet(`counter:${key}`, n);
    return n;
  }

  // ───────────── events ─────────────

  appendEvent(e: NewEvent): OrchestratorEvent | null {
    if (this.closed) return null;
    const id = e.id ?? newId();
    if (this.eventIds.has(id)) return null;
    const stored: OrchestratorEvent = {
      ...(e as any),
      id,
      ts: e.ts ?? nowIso(),
      seq: ++this.lastSeq,
      summary: redactSecrets(e.summary),
      data: redactDeep(e.data ?? {}),
      correlationId: e.correlationId ?? null,
      hostId: e.hostId ?? null,
      sessionId: e.sessionId ?? null,
      employeeId: e.employeeId ?? null,
      taskId: e.taskId ?? null,
      projectId: e.projectId ?? null,
    };
    this.eventIds.add(id);
    this.events.push(stored);
    if (this.events.length > this.window * 1.1) {
      for (const old of this.events.splice(0, this.events.length - this.window)) this.eventIds.delete(old.id);
    }
    this.write(
      'INSERT INTO orch_events (seq, id, ts, type, host_id, session_id, employee_id, task_id, project_id, correlation_id, summary, source, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb) ON CONFLICT (id) DO NOTHING',
      [stored.seq, id, stored.ts, stored.type, stored.hostId, stored.sessionId, stored.employeeId, stored.taskId, stored.projectId, stored.correlationId, stored.summary, JSON.stringify(stored.source), JSON.stringify(stored.data)],
    );
    return stored;
  }

  queryEvents(q: EventQuery = {}): OrchestratorEvent[] {
    const limit = Math.max(1, Math.min(2000, q.limit ?? 200));
    const types = q.types?.length ? new Set(q.types) : null;
    const exclude = q.excludeTypes?.length ? new Set(q.excludeTypes) : null;
    const out: OrchestratorEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.events[i]!;
      if (q.beforeSeq && e.seq >= q.beforeSeq) continue;
      if (q.since && e.ts < q.since) continue;
      if (q.employeeId && e.employeeId !== q.employeeId) continue;
      if (q.taskId && e.taskId !== q.taskId) continue;
      if (q.sessionId && e.sessionId !== q.sessionId) continue;
      if (q.projectId && e.projectId !== q.projectId) continue;
      if (types && !types.has(e.type)) continue;
      if (exclude && exclude.has(e.type)) continue;
      out.push(e);
    }
    return out.reverse();
  }

  markProcessed(id: string): boolean {
    if (this.closed || this.processed.has(id)) return false;
    const ts = Date.now();
    this.processed.set(id, ts);
    this.write('INSERT INTO orch_processed (id, ts) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, new Date(ts).toISOString()]);
    return true;
  }

  pruneProcessed(olderThanDays = 7): void {
    if (this.closed) return;
    const cutoff = Date.now() - olderThanDays * 86400_000;
    for (const [id, ts] of this.processed) if (ts < cutoff) this.processed.delete(id);
    this.write('DELETE FROM orch_processed WHERE ts < $1', [new Date(cutoff).toISOString()]);
  }

  // ───────────── credentials ─────────────

  addCredential(kind: CredentialKind, token: string, opts: { refId?: string | null; label?: string | null; ttlMs?: number } = {}): void {
    if (this.closed) return;
    const row: CredRow = { hash: hashToken(token), kind, refId: opts.refId ?? null, label: opts.label ?? null, createdAt: nowIso(), expiresAt: opts.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : null, usedAt: null, revokedAt: null };
    this.creds.set(row.hash, row);
    this.write('INSERT INTO orch_credentials (hash, kind, ref_id, label, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (hash) DO UPDATE SET kind = EXCLUDED.kind, ref_id = EXCLUDED.ref_id, label = EXCLUDED.label, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, used_at = NULL, revoked_at = NULL', [
      row.hash,
      kind,
      row.refId,
      row.label,
      row.createdAt,
      row.expiresAt,
    ]);
  }

  checkCredential(kind: CredentialKind, token: string | null | undefined): CredentialRecord | null {
    if (!token || this.closed) return null;
    const r = this.creds.get(hashToken(token));
    if (!r || r.kind !== kind || r.revokedAt) return null;
    if (r.expiresAt && r.expiresAt < nowIso()) return null;
    const { hash: _hash, ...record } = r;
    return record;
  }

  markCredentialUsed(token: string): void {
    const r = this.creds.get(hashToken(token));
    if (!r || this.closed) return;
    r.usedAt = nowIso();
    this.write('UPDATE orch_credentials SET used_at = $1 WHERE hash = $2', [r.usedAt, r.hash]);
  }

  revokeCredential(token: string): void {
    const r = this.creds.get(hashToken(token));
    if (!r || r.revokedAt || this.closed) return;
    r.revokedAt = nowIso();
    this.write('UPDATE orch_credentials SET revoked_at = $1 WHERE hash = $2', [r.revokedAt, r.hash]);
  }

  revokeCredentialsFor(kind: CredentialKind, refId: string): void {
    if (this.closed) return;
    const now = nowIso();
    for (const r of this.creds.values()) if (r.kind === kind && r.refId === refId && !r.revokedAt) r.revokedAt = now;
    this.write('UPDATE orch_credentials SET revoked_at = $1 WHERE kind = $2 AND ref_id = $3 AND revoked_at IS NULL', [now, kind, refId]);
  }

  listCredentials(kind: CredentialKind): Array<CredentialRecord & { hashPrefix: string }> {
    return [...this.creds.values()]
      .filter((r) => r.kind === kind)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(({ hash, ...r }) => ({ ...r, hashPrefix: hash.slice(0, 10) }));
  }

  // ───────────── audit ─────────────

  audit(actor: string, action: string, target: string, detail: Record<string, unknown> = {}): AuditEntry {
    const entry: AuditEntry = { id: newId(), ts: nowIso(), actor, action, target, detail: redactDeep(detail) };
    if (this.closed) return entry;
    this.auditLog.push(entry);
    if (this.auditLog.length > 4000) this.auditLog.splice(0, this.auditLog.length - 2000);
    this.write('INSERT INTO orch_audit (id, ts, actor, action, target, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [entry.id, entry.ts, actor, action, target, JSON.stringify(entry.detail)]);
    return entry;
  }

  recentAudit(limit = 200): AuditEntry[] {
    return this.auditLog.slice(-Math.min(2000, limit)).reverse();
  }
}
