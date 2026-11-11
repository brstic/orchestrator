/**
 * Knocking: asking to be let into the office without an invitation.
 *
 * Someone opens the office's address in a browser, or types it into the desktop app, gives a name
 * and knocks. Nothing is granted by that: the people who are inside see who is at the door (with a
 * short code the person at the door sees too, so the two can be matched by voice or message) and
 * one of them lets the person in — choosing as what — or does not. Only then is a member made, with
 * a credential of their own that the knocker collects exactly once.
 *
 * What this module holds is in memory only: a restart of the office empties the doorstep.
 */
import crypto from 'node:crypto';
import { nowIso } from '@orchestrator/contracts';
import { EngineError } from '@orchestrator/orchestration';

export type KnockVia = 'browser' | 'app';

/** Someone at the door, as the people inside see them. */
export interface Knock {
  id: string;
  name: string;
  /** How they came: the office's page in a browser (they can only be let in to look), or the desktop app. */
  via: KnockVia;
  /** Four digits shown to both sides. */
  code: string;
  at: string;
}

/** What the knocker is handed, once, after being let in. */
export interface Admission {
  role: 'visitor' | 'colleague' | 'owner';
  name: string;
  token: string;
  /** The same thing as an invitation, for the desktop app to keep. */
  invite: string;
  /** Set when the admission ends by itself (a browser visit). */
  expiresAt: string | null;
  /** The member that was made, to take back if nobody collects it. */
  memberId: string;
}

export type KnockAnswer = { status: 'waiting'; code: string } | { status: 'admitted'; role: Admission['role']; name: string; token: string; invite: string; expiresAt: string | null } | { status: 'refused' } | { status: 'gone' };

interface Pending extends Knock {
  secretHash: Buffer;
  ip: string;
  createdAt: number;
  lastPollAt: number;
  outcome: null | { status: 'refused'; at: number } | { status: 'admitted'; at: number; admission: Admission };
}

export const KNOCK_LIMITS = {
  /** People on the doorstep at once, in all and from one address. */
  pending: 10,
  pendingPerIp: 2,
  /** Knocks from one address in ten minutes. */
  perIpPerWindow: 6,
  windowMs: 10 * 60_000,
  /** A knocker who stops asking has walked away. */
  silentMs: 25_000,
  /** Nobody stands at a door longer than this. */
  maxWaitMs: 10 * 60_000,
  /** An answer nobody collected is taken back after this. */
  uncollectedMs: 60_000,
};

const hash = (s: string): Buffer => crypto.createHash('sha256').update(s).digest();

export class Knocks {
  private pending = new Map<string, Pending>();
  private byIp = new Map<string, number[]>();
  private timer: NodeJS.Timeout;
  private onChange: () => void;
  private takeBack: (memberId: string) => void;
  private now: () => number;

  constructor(opts: { onChange: () => void; takeBack: (memberId: string) => void; now?: () => number }) {
    this.onChange = opts.onChange;
    this.takeBack = opts.takeBack;
    this.now = opts.now ?? Date.now;
    this.timer = setInterval(() => this.sweep(), 5000);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** Who is waiting to be answered, oldest first. */
  list(): Knock[] {
    return [...this.pending.values()]
      .filter((k) => !k.outcome)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ id, name, via, code, at }) => ({ id, name, via, code, at }));
  }

  knock(input: { name: unknown; via: unknown; ip: string }): { id: string; secret: string; code: string } {
    const name = String(input.name ?? '')
      .normalize('NFKC')
      .replace(/\p{Cf}/gu, '') // what cannot be seen is not part of a name (and must not split one)
      .replace(/[\u0000-\u001f\u007f<>]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    if (name.length < 2) throw new EngineError('Say who you are: a name of at least two letters.');
    const now = this.now();
    const ip = input.ip || 'unknown';
    const recent = (this.byIp.get(ip) ?? []).filter((t) => now - t < KNOCK_LIMITS.windowMs);
    const waiting = [...this.pending.values()].filter((k) => !k.outcome);
    if (recent.length >= KNOCK_LIMITS.perIpPerWindow || waiting.filter((k) => k.ip === ip).length >= KNOCK_LIMITS.pendingPerIp) throw new EngineError('You have knocked several times already. Wait a few minutes before trying again.', 429);
    if (waiting.length >= KNOCK_LIMITS.pending) throw new EngineError('There is a queue at the door right now. Try again in a moment.', 429);
    recent.push(now);
    this.byIp.set(ip, recent);
    const secret = crypto.randomBytes(32).toString('base64url');
    const k: Pending = { id: crypto.randomUUID(), name, via: input.via === 'app' ? 'app' : 'browser', code: String(crypto.randomInt(0, 10000)).padStart(4, '0'), at: nowIso(), secretHash: hash(secret), ip, createdAt: now, lastPollAt: now, outcome: null };
    this.pending.set(k.id, k);
    this.onChange();
    return { id: k.id, secret, code: k.code };
  }

  private mine(id: string, secret: unknown): Pending | null {
    const k = this.pending.get(id);
    if (!k || typeof secret !== 'string' || !secret) return null;
    return crypto.timingSafeEqual(k.secretHash, hash(secret)) ? k : null;
  }

  /** The knocker asks how it stands. An admission is handed over once; after that the knock is gone. */
  poll(id: string, secret: unknown): KnockAnswer {
    const k = this.mine(id, secret);
    if (!k) return { status: 'gone' };
    k.lastPollAt = this.now();
    if (!k.outcome) return { status: 'waiting', code: k.code };
    this.pending.delete(id);
    if (k.outcome.status === 'refused') return { status: 'refused' };
    const a = k.outcome.admission;
    return { status: 'admitted', role: a.role, name: a.name, token: a.token, invite: a.invite, expiresAt: a.expiresAt };
  }

  /** The knocker gave up. */
  leave(id: string, secret: unknown): void {
    const k = this.mine(id, secret);
    if (!k) return;
    this.pending.delete(id);
    if (k.outcome?.status === 'admitted') this.takeBack(k.outcome.admission.memberId);
    this.onChange();
  }

  /** Someone inside decides. `make` creates the member; it is called only if the knock is still waiting. */
  admit(id: string, make: (k: Knock) => Admission): Knock {
    const k = this.pending.get(id);
    if (!k || k.outcome) throw new EngineError('They are no longer at the door (someone else answered, or they left).', 404);
    k.outcome = { status: 'admitted', at: this.now(), admission: make(k) };
    this.onChange();
    return k;
  }

  refuse(id: string): Knock {
    const k = this.pending.get(id);
    if (!k || k.outcome) throw new EngineError('They are no longer at the door (someone else answered, or they left).', 404);
    k.outcome = { status: 'refused', at: this.now() };
    this.onChange();
    return k;
  }

  /** Whoever walked away, waited too long, or never collected their answer is cleared from the doorstep. */
  sweep(): void {
    const now = this.now();
    let changed = false;
    for (const k of [...this.pending.values()]) {
      if (k.outcome) {
        if (now - k.outcome.at < KNOCK_LIMITS.uncollectedMs) continue;
        if (k.outcome.status === 'admitted') this.takeBack(k.outcome.admission.memberId);
        this.pending.delete(k.id);
      } else if (now - k.lastPollAt > KNOCK_LIMITS.silentMs || now - k.createdAt > KNOCK_LIMITS.maxWaitMs) {
        this.pending.delete(k.id);
        changed = true;
      }
    }
    for (const [ip, times] of this.byIp) if (times.every((t) => now - t >= KNOCK_LIMITS.windowMs)) this.byIp.delete(ip);
    if (changed) this.onChange();
  }
}
