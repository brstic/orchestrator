/**
 * The vault: where the office keeps credentials — passwords, tokens, keys.
 *
 * Values are encrypted on the server (AES-256-GCM; the key is a file next to the office's database, or
 * `ORCH_VAULT_KEY`) and stored under a short name. Everything else in the office — messages, tasks, events,
 * the audit log, the list the vault's window shows — carries the name, never the value.
 *
 *   in    an owner or a colleague adds one in the vault's window; an employee stores one it was given or
 *         made (`vault_store`, or the helper's `put`, which takes the value from a pipe so that it never
 *         passes through the model); and the office itself moves a credential out of a message somebody
 *         wrote (`capture`: the message goes on with `{{vault:name}}` where the value was) and keeps one
 *         it saw go through a session in a well-known format (`noticed`).
 *   out   an employee's command asks for it by name through the helper in its session
 *         (`$("$ORCH_VAULT" get name)`): the value goes into the command, not into the conversation. An owner
 *         can look at one in the window (`reveal`). Every use is on the record: who, which, when.
 *
 * Who may do what is decided where every other permission is (`apps/server/src/access.ts`, and for sessions
 * by the session's own token at the worker endpoint).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newId, nowIso } from '@orchestrator/contracts';
import { EngineError, type Core } from './core.ts';
import { PLACEHOLDER, detectSecrets, nameFor, placeholder, slug, uniqueName, type FoundSecret, type SecretKind } from './vault-detect.ts';

export type VaultSource = 'added' | 'stored' | 'captured' | 'noticed';

/** Who put a credential in, or took it out. */
export interface VaultActor {
  kind: 'owner' | 'member' | 'employee' | 'office';
  id: string | null;
  name: string;
}

/** A credential as everybody but the vault itself sees it: no value. */
export interface VaultEntry {
  id: string;
  name: string;
  kind: SecretKind;
  /** The site, host or product it opens. */
  service: string;
  /** The login it goes with. */
  username: string;
  description: string;
  /** added: typed into the vault's window. stored: an employee put it there. captured: taken out of a message. noticed: seen going through a session. */
  source: VaultSource;
  createdAt: string;
  createdBy: VaultActor;
  updatedAt: string;
  uses: number;
  lastUsedAt: string | null;
  lastUsedBy: VaultActor | null;
  /** How long the value is, so the window can show that there is one without showing it. */
  length: number;
}

interface Stored extends VaultEntry {
  /** iv (12) + tag (16) + ciphertext, base64. */
  secret: string;
  /** HMAC of the value under the vault's key: the same value is recognised without being readable. */
  fingerprint: string;
}

export interface VaultInput {
  name?: string;
  value: string;
  kind?: SecretKind;
  service?: string;
  username?: string;
  description?: string;
}

const KV = 'vault';
const KINDS: SecretKind[] = ['password', 'api_key', 'token', 'ssh_key', 'other'];
const MAX_VALUE = 16_384;
const MAX_ENTRIES = 2000;

export class Vault {
  private core: Core;
  private keyFile: string | null;
  private key: Buffer | null = null;
  private entries = new Map<string, Stored>();

  constructor(core: Core, keyFile: string | null) {
    this.core = core;
    this.keyFile = keyFile;
    for (const e of core.store.kvGet<Stored[]>(KV, [])) this.entries.set(e.id, e);
  }

  // ─────────────────────────── the key ───────────────────────────

  /** The vault's key: from the environment, else a file made on first use (mode 600) next to the office's database. */
  private secretKey(): Buffer {
    if (this.key) return this.key;
    const fromEnv = process.env.ORCH_VAULT_KEY;
    if (fromEnv) {
      const raw = Buffer.from(fromEnv, 'base64');
      if (raw.length !== 32) throw new EngineError('ORCH_VAULT_KEY must be 32 bytes, base64-encoded', 500);
      return (this.key = raw);
    }
    if (!this.keyFile) {
      // No place to keep a key (an engine built without a data folder, as in unit tests): one for this run only.
      this.core.log('warn', 'the vault has no key file: what is stored now cannot be read after a restart');
      return (this.key = crypto.randomBytes(32));
    }
    if (fs.existsSync(this.keyFile)) {
      const raw = Buffer.from(fs.readFileSync(this.keyFile, 'utf8').trim(), 'base64');
      if (raw.length !== 32) throw new EngineError(`the vault's key file is damaged (${this.keyFile})`, 500);
      return (this.key = raw);
    }
    const fresh = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.keyFile, `${fresh.toString('base64')}\n`, { mode: 0o600 });
    this.core.log('info', `the vault's key was made: ${this.keyFile} (keep it with the office's backups; without it nothing in the vault can be read)`);
    return (this.key = fresh);
  }

  private encrypt(value: string, id: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.secretKey(), iv);
    cipher.setAAD(Buffer.from(id));
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  private decrypt(e: Stored): string {
    const raw = Buffer.from(e.secret, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.secretKey(), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(e.id));
    decipher.setAuthTag(raw.subarray(12, 28));
    try {
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      throw new EngineError(`"${e.name}" cannot be read: the vault's key is not the one it was stored with`, 500);
    }
  }

  private fingerprint(value: string): string {
    return crypto.createHmac('sha256', this.secretKey()).update(value).digest('hex');
  }

  // ─────────────────────────── reading ───────────────────────────

  private save(): void {
    this.core.store.kvSet(KV, [...this.entries.values()]);
    // Windows that show the vault ask for the list again; nothing about its contents is broadcast.
    this.core.bus.emit('vault');
  }

  private view(e: Stored): VaultEntry {
    const { secret: _s, fingerprint: _f, ...rest } = e;
    return rest;
  }

  /** What is in the vault, by name: never a value. */
  list(query = ''): VaultEntry[] {
    const q = query.trim().toLowerCase();
    return [...this.entries.values()]
      .filter((e) => !q || `${e.name} ${e.service} ${e.username} ${e.description} ${e.kind}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => this.view(e));
  }

  get size(): number {
    return this.entries.size;
  }

  private byName(name: string): Stored | undefined {
    const n = String(name ?? '').trim().toLowerCase().replace(/^\{\{vault:|\}\}$/g, '');
    return [...this.entries.values()].find((e) => e.name === n);
  }

  private require(ref: string): Stored {
    const e = this.entries.get(ref) ?? this.byName(ref);
    if (!e) throw new EngineError(`there is nothing called "${ref}" in the vault`, 404);
    return e;
  }

  /** The names in a text's placeholders that the vault really has. */
  mentioned(text: string): string[] {
    return [...new Set([...String(text ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]!))].filter((n) => !!this.byName(n));
  }

  // ─────────────────────────── putting in ───────────────────────────

  /** Put a credential in. The same value under the same name is not stored twice; a taken name gets a qualifier. */
  put(input: VaultInput, by: VaultActor, source: VaultSource): { entry: VaultEntry; created: boolean } {
    const value = String(input.value ?? '');
    if (!value.trim()) throw new EngineError('a credential needs a value');
    if (value.length > MAX_VALUE) throw new EngineError('that is too long for one credential');
    const fp = this.fingerprint(value);
    const same = [...this.entries.values()].find((e) => e.fingerprint === fp);
    if (same) return { entry: this.view(same), created: false };
    if (this.entries.size >= MAX_ENTRIES) throw new EngineError('the vault is full; remove what is no longer needed');
    const kind: SecretKind = KINDS.includes(input.kind as SecretKind) ? (input.kind as SecretKind) : 'password';
    const service = String(input.service ?? '').trim().slice(0, 120);
    const username = String(input.username ?? '').trim().slice(0, 120);
    const wanted = slug(String(input.name ?? ''), 60) || nameFor({ kind, service, username }, [by.kind === 'employee' ? by.name : '']);
    const taken = new Set([...this.entries.values()].map((e) => e.name));
    const now = nowIso();
    const id = newId();
    const entry: Stored = {
      id,
      name: uniqueName(wanted, taken, [service, username]),
      kind,
      service,
      username,
      description: String(input.description ?? '').trim().slice(0, 300),
      source,
      createdAt: now,
      createdBy: by,
      updatedAt: now,
      uses: 0,
      lastUsedAt: null,
      lastUsedBy: null,
      length: value.length,
      secret: this.encrypt(value, id),
      fingerprint: fp,
    };
    this.entries.set(id, entry);
    this.save();
    this.core.audit(actorOf(by), 'vault.stored', id, { name: entry.name, kind, service, source });
    this.core.event({
      type: 'vault.stored',
      source: by.kind === 'employee' ? 'mcp' : by.kind === 'office' ? 'server' : 'owner',
      summary: `${by.kind === 'office' ? 'The office' : by.name} put "${entry.name}" in the vault${source === 'captured' ? ' (taken out of a message)' : source === 'noticed' ? ' (seen in a session)' : ''}`,
      employeeId: by.kind === 'employee' ? by.id : null,
      data: { name: entry.name, kind, service, source },
    });
    return { entry: this.view(entry), created: true };
  }

  /** Change what is known about a credential (never its value: store a new one for that). */
  update(ref: string, patch: Partial<Pick<VaultEntry, 'name' | 'service' | 'username' | 'description' | 'kind'>>, by: VaultActor): VaultEntry {
    const e = this.require(ref);
    if (patch.name !== undefined) {
      const name = slug(String(patch.name), 60);
      if (!name) throw new EngineError('a name is letters, digits and dashes');
      if (name !== e.name && this.byName(name)) throw new EngineError(`there is already something called "${name}" in the vault`);
      e.name = name;
    }
    if (patch.service !== undefined) e.service = String(patch.service).trim().slice(0, 120);
    if (patch.username !== undefined) e.username = String(patch.username).trim().slice(0, 120);
    if (patch.description !== undefined) e.description = String(patch.description).trim().slice(0, 300);
    if (patch.kind !== undefined && KINDS.includes(patch.kind)) e.kind = patch.kind;
    e.updatedAt = nowIso();
    this.save();
    this.core.audit(actorOf(by), 'vault.updated', e.id, { name: e.name, fields: Object.keys(patch) });
    return this.view(e);
  }

  remove(ref: string, by: VaultActor): VaultEntry {
    const e = this.require(ref);
    this.entries.delete(e.id);
    this.save();
    this.core.audit(actorOf(by), 'vault.removed', e.id, { name: e.name });
    this.core.event({ type: 'vault.removed', source: 'owner', summary: `${by.name} removed "${e.name}" from the vault`, data: { name: e.name } });
    return this.view(e);
  }

  // ─────────────────────────── taking out ───────────────────────────

  /** The value itself, for a command that needs it or for an owner who asked to see it. Every use is on the record. */
  use(ref: string, by: VaultActor, how: 'used' | 'revealed' = 'used'): { entry: VaultEntry; value: string } {
    const e = this.require(ref);
    const value = this.decrypt(e);
    e.uses++;
    e.lastUsedAt = nowIso();
    e.lastUsedBy = by;
    this.core.store.kvSet(KV, [...this.entries.values()]);
    this.core.audit(actorOf(by), how === 'revealed' ? 'vault.revealed' : 'vault.used', e.id, { name: e.name });
    // Uses by employees are frequent and say nothing new after the first: the feed gets the first one, the audit log all.
    if (how === 'used' && e.uses === 1) this.core.event({ type: 'vault.used', source: 'mcp', summary: `${by.name} used "${e.name}" from the vault`, employeeId: by.kind === 'employee' ? by.id : null, data: { name: e.name, quiet: true } });
    return { entry: this.view(e), value };
  }

  // ─────────────────────────── by itself ───────────────────────────

  /**
   * Take the credentials out of a text somebody wrote — a message to an employee, a task — and keep them here:
   * what comes back reads `{{vault:name}}` where each value was, so the value itself is not delivered, stored
   * with the message or shown in the feed. A value already in the vault is replaced by the name it has.
   */
  capture(text: string, by: VaultActor, hints: string[] = []): { text: string; names: string[] } {
    const found = detectSecrets(text);
    if (!found.length) return { text, names: [] };
    let out = '';
    let at = 0;
    const names: string[] = [];
    for (const f of found) {
      let name: string;
      try {
        name = this.put({ name: nameFor(f, hints), value: f.value, kind: f.kind, service: f.service, username: f.username, description: describe(f) }, by, 'captured').entry.name;
      } catch (e) {
        // Could not be stored (the vault is full, the key is unreadable): the text goes on as it was written.
        this.core.log('warn', `vault: a credential in a message was not captured: ${(e as Error).message}`);
        continue;
      }
      out += text.slice(at, f.start) + placeholder(name);
      at = f.end;
      names.push(name);
    }
    return { text: out + text.slice(at), names: [...new Set(names)] };
  }

  /**
   * Something in a well-known credential format went through a session (a prompt, a command, what a tool returned):
   * keep it, so that it is not lost in a terminal's scrollback. Only formats that cannot be mistaken — a provider's
   * token, a private key, a password inside a URL — are kept this way.
   */
  noticed(text: string, by: VaultActor, hints: string[] = []): string[] {
    const sure = new Set(['private_key', 'anthropic_key', 'openai_key', 'aws_access_key', 'github_token', 'gitlab_token', 'slack_token', 'google_api_key', 'stripe_key', 'url_password']);
    const names: string[] = [];
    for (const f of detectSecrets(text)) {
      if (!sure.has(f.pattern)) continue;
      try {
        const res = this.put({ name: nameFor(f, hints), value: f.value, kind: f.kind, service: f.service, username: f.username, description: describe(f) }, by, 'noticed');
        if (res.created) names.push(res.entry.name);
      } catch (e) {
        this.core.log('warn', `vault: a credential seen in a session was not kept: ${(e as Error).message}`);
      }
    }
    return names;
  }
}

const actorOf = (by: VaultActor): string => (by.kind === 'owner' ? 'owner' : by.kind === 'office' ? 'office' : `${by.kind}:${by.name}`);

function describe(f: FoundSecret): string {
  const what = f.kind === 'ssh_key' ? 'A private key' : f.kind === 'api_key' ? 'An API key' : f.kind === 'token' ? 'A token' : 'A password';
  return `${what}${f.service ? ` for ${f.service}` : ''}${f.username ? ` (${f.username})` : ''}`;
}
