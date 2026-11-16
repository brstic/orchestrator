/**
 * Signing in to the office with a name and a password — a second way in for a member, beside their invitation.
 *
 * A member is still a member (`guests.ts`): the password only proves who is asking, and what they get is a session
 * credential of *that member*, with that member's role, for thirty days. It is never the office's own owner token
 * (which is not accepted from the network at all).
 *
 * The password is kept as a salted scrypt hash, apart from the member records (those are sent to clients). Guessing
 * is slowed down twice: a name is closed for a while after a run of wrong passwords, and so is an address that keeps
 * trying names.
 */
import crypto from 'node:crypto';
import { generateToken, type CredentialKind } from '@orchestrator/database';
import { EngineError, type Engine } from '@orchestrator/orchestration';
import type { Guest, Guests } from './guests.ts';

/** Whoever signs in with a password: a member (`guests.ts`), or a client of the Rent portal (`rent-door.ts`). */
export interface Person {
  id: string;
  name: string;
  revokedAt: string | null;
  expiresAt?: string | null;
}
export interface People<P extends Person = Person> {
  get(id: string): P | undefined;
  list(): P[];
}
/** Where one kind of person's passwords are kept, which credentials their sessions are, and what they are called. */
export interface LoginsOptions {
  kv: string;
  kind: CredentialKind;
  /** "member" or "client": in the record and in what the owners are told. */
  label: string;
}

const KV = 'logins';
const MIN = 8;
const MAX = 200;
export const SESSION_DAYS = 30;
/** Wrong passwords in a row for one name before it is closed, and for how long (doubling up to a day). */
const NAME_TRIES = 5;
const NAME_LOCK_MS = 15 * 60_000;
/** Wrong attempts from one address within the window before that address is turned away. */
const IP_TRIES = 20;
const IP_WINDOW_MS = 10 * 60_000;
/** Checks in flight at once, and attempts of everybody together within a minute, before the door says "later". */
// (Each check takes 16 MB while it is computed; eight side by side is more than this office's people will ever need.)
const BUSY = 8;
const ALL_TRIES = 120;
const ALL_WINDOW_MS = 60_000;
/** How a session made by signing in is told from the credential a member's app keeps. A member's name never holds a tab. */
const SESSION = 'login\t';
export const LOGIN_LIMITS = { nameTries: NAME_TRIES, nameLockMs: NAME_LOCK_MS, ipTries: IP_TRIES, ipWindowMs: IP_WINDOW_MS, min: MIN, busy: BUSY, allTries: ALL_TRIES, allWindowMs: ALL_WINDOW_MS };

interface Stored {
  salt: string;
  hash: string;
  setAt: string;
  setBy: string;
}

const COST = { N: 16384, r: 8, p: 1 };
/** Setting a password (an owner's act, or one's own): computed at once. */
const scrypt = (password: string, salt: Buffer): Buffer => crypto.scryptSync(password.normalize('NFKC'), salt, 64, COST);
/** Checking one at the door: computed off the office's own thread, so that people who guess cannot hold the office up. */
const scryptLater = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => crypto.scrypt(password.normalize('NFKC'), salt, 64, COST, (err, key) => (err ? reject(err) : resolve(key))));


export class Logins<P extends Person = Guest> {
  private engine: Engine;
  private guests: People<P>;
  private opts: LoginsOptions;
  private stored: Record<string, Stored>;
  private names = new Map<string, { fails: number; until: number; locks: number }>();
  private ips = new Map<string, number[]>();
  /** Checks being computed right now, and when the attempts of the last minute were made (everybody's). */
  private inFlight = 0;
  private recentAll: number[] = [];

  private now: () => number;

  /** Told when sign-in sessions of a member have ended: all of them, or the one this token was. */
  onEnded: (guestId: string, token?: string) => void = () => undefined;

  /** A name for a session that can be kept with an open connection without keeping the token itself. */
  static keyOf(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
  }

  constructor(engine: Engine, guests: Guests | People<P>, now: () => number = Date.now, opts: LoginsOptions = { kv: KV, kind: 'guest', label: 'member' }) {
    this.engine = engine;
    this.guests = guests as People<P>;
    this.now = now;
    this.opts = opts;
    this.stored = engine.core.store.kvGet<Record<string, Stored>>(opts.kv, {});
  }

  has(guestId: string): boolean {
    return !!this.stored[guestId];
  }

  /** Give a member a password (or a new one). What they are signed in with elsewhere through a password stops working. */
  set(guestId: string, password: unknown, actor: string): void {
    const guest = this.guests.get(guestId);
    if (!guest || guest.revokedAt) throw new EngineError(`unknown ${this.opts.label}`, 404);
    const pw = typeof password === 'string' ? password : '';
    if (pw.length < MIN) throw new EngineError(`a password has at least ${MIN} characters`);
    if (pw.length > MAX) throw new EngineError('that password is too long');
    if (pw.toLowerCase() === guest.name.toLowerCase()) throw new EngineError('the password must not be the name');
    const salt = crypto.randomBytes(16);
    this.stored[guestId] = { salt: salt.toString('hex'), hash: scrypt(pw, salt).toString('hex'), setAt: new Date().toISOString(), setBy: actor };
    this.save();
    this.endSessions(guestId);
    this.names.delete(guest.name.toLowerCase());
    this.engine.core.audit(actor, 'login.password_set', guestId, { name: guest.name });
  }

  clear(guestId: string, actor: string): void {
    if (!this.stored[guestId]) return;
    delete this.stored[guestId];
    this.save();
    this.endSessions(guestId);
    this.engine.core.audit(actor, 'login.password_removed', guestId, { name: this.guests.get(guestId)?.name });
  }

  private save(): void {
    this.engine.core.store.kvSet(this.opts.kv, this.stored);
  }

  /** Sessions made by signing in (not the member's own app's credential) end. */
  private endSessions(guestId: string): void {
    this.engine.core.store.revokeCredentialsWhere(this.opts.kind, guestId, SESSION);
    this.onEnded(guestId);
  }

  /**
   * A name and a password at the door. The member's session credential, or an error that says no more than it must:
   * the same words for a wrong name and a wrong password.
   */
  async signIn(username: unknown, password: unknown, ip: string): Promise<{ guest: P; token: string; expiresAt: string }> {
    const guest = await this.check(username, password, ip);
    return { guest, ...this.session(guest, ip) };
  }

  /** A new sign-in session for this person (signing in, or setting their first password with an invitation). */
  session(guest: P, ip: string): { token: string; expiresAt: string } {
    const ttlMs = SESSION_DAYS * 24 * 60 * 60_000;
    const token = generateToken(this.opts.kind === 'guest' ? 'orch_guest' : `orch_${this.opts.kind}`);
    this.engine.core.store.addCredential(this.opts.kind, token, { refId: guest.id, label: `${SESSION}${guest.name}`, ttlMs });
    this.engine.core.audit(`${this.opts.label}:${guest.name}`, 'login.signed_in', guest.id, { name: guest.name, ...('role' in guest ? { role: (guest as unknown as Guest).role } : {}), ip });
    return { token, expiresAt: new Date(this.now() + ttlMs).toISOString() };
  }

  /** Is this the member's password? Counted like an attempt at the door (the same locks), and it throws like one. */
  async check(username: unknown, password: unknown, ip: string): Promise<P> {
    const name = String(username ?? '').trim().toLowerCase();
    const pw = typeof password === 'string' ? password : '';
    const now = this.now();
    const recent = (this.ips.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
    if (recent.length >= IP_TRIES) throw new EngineError('Too many attempts from here. Try again in a few minutes.', 429);
    // Everybody together: a flood of attempts from many addresses is turned away as a whole, before any work is done for it.
    this.recentAll = this.recentAll.filter((t) => now - t < ALL_WINDOW_MS);
    if (this.recentAll.length >= ALL_TRIES || this.inFlight >= BUSY) throw new EngineError('Too many people are signing in right now. Try again in a minute.', 429);
    const lock = this.names.get(name);
    if (lock && lock.until > now) throw new EngineError(`Too many wrong passwords for this name. Try again in ${Math.max(1, Math.ceil((lock.until - now) / 60_000))} minutes.`, 429);
    const guest = name && pw && pw.length <= MAX ? this.guests.list().find((g) => !g.revokedAt && !(g.expiresAt && Date.parse(g.expiresAt) <= now) && g.name.toLowerCase() === name) : undefined;
    const rec = guest ? this.stored[guest.id] : undefined;
    // The work of checking is done either way, so that a name that exists does not answer differently in time.
    const salt = rec ? Buffer.from(rec.salt, 'hex') : Buffer.alloc(16, 7);
    this.recentAll.push(now);
    this.inFlight++;
    let got: Buffer;
    try {
      got = await scryptLater(pw || 'x', salt);
    } finally {
      this.inFlight--;
    }
    // (The password may have been changed or taken away while this was computed: what is stored now decides.)
    const ok = !!rec && this.stored[guest!.id] === rec && crypto.timingSafeEqual(got, Buffer.from(rec.hash, 'hex'));
    if (!guest || !ok) {
      // (Counted from what is known now: other attempts from this address may have ended while this one was computed.)
      this.ips.set(ip, [...(this.ips.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS), now]);
      if (this.ips.size > 5000) this.ips.clear();
      if (name) {
        const n = this.names.get(name) ?? { fails: 0, until: 0, locks: 0 };
        n.fails++;
        if (n.fails >= NAME_TRIES) {
          n.locks++;
          n.fails = 0;
          n.until = now + Math.min(NAME_LOCK_MS * 2 ** (n.locks - 1), 24 * 60 * 60_000);
          this.engine.core.audit('door', 'login.locked', guest?.id ?? name, { name, ip, minutes: Math.round((n.until - now) / 60_000) });
          if (guest) this.engine.comms.notify({ kind: 'security', severity: 'warning', title: `Sign-in for ${guest.name} is closed for a while`, body: `Five wrong passwords in a row (last from ${ip}). Nobody can sign in under that name for ${Math.round((n.until - now) / 60_000)} minutes${this.opts.kind === 'guest' ? '; an invitation and the desktop app still work' : ` (a ${this.opts.label})`}.` });
        }
        this.names.set(name, n);
        if (this.names.size > 5000) this.names.clear();
      }
      this.engine.core.audit('door', 'login.failed', guest?.id ?? 'unknown', { name: name.slice(0, 40), ip });
      throw new EngineError(this.opts.kind === 'guest' ? 'That name and password do not match a member of this office.' : 'That name and password do not match.', 401);
    }
    this.names.delete(name);
    return guest;
  }

  /** Is this token a session made by signing in with a password (rather than the credential a member's app keeps)? */
  isSession(token: string | null): boolean {
    return !!token && !!this.engine.core.store.checkCredential(this.opts.kind, token)?.label?.startsWith(SESSION);
  }

  /** End the session this token is — only one made by signing in; a member's app keeps its own credential. */
  signOut(token: string | null): boolean {
    if (!token || !this.isSession(token)) return false;
    const guestId = this.engine.core.store.checkCredential(this.opts.kind, token)?.refId;
    this.engine.core.store.revokeCredential(token);
    if (guestId) this.onEnded(guestId, token);
    return true;
  }
}
