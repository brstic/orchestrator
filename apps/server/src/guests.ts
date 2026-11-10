/**
 * Other people in the office. The owner invites guests by name with one of two roles; each guest
 * gets a credential of their own, which can be revoked at any time and is never the owner's token.
 *
 *   visitor   — sees the office and what happens in it, walks around, talks to the other people.
 *               No terminals, no documents, and nothing can be changed.
 *   colleague — also watches terminals (read-only), reads documents and diffs, talks to employees,
 *               creates and edits tasks, starts meetings, and answers employees' questions
 *               (never permission requests).
 *
 * Everything else stays with the owner: approvals, taking the keyboard of a terminal, hiring,
 * machines and SSH links, settings and policies, merging and promoting, the office layout.
 */
import crypto from 'node:crypto';
import { newId, nowIso } from '@orchestrator/contracts';
import { generateToken } from '@orchestrator/database';
import { EngineError, type Engine } from '@orchestrator/orchestration';

export type GuestRole = 'visitor' | 'colleague';

export interface Guest {
  id: string;
  name: string;
  role: GuestRole;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

/** Who is making a request. */
export type Who = { kind: 'owner'; id: 'owner'; name: string; role: 'owner' } | { kind: 'guest'; id: string; name: string; role: GuestRole };

/** Someone present in the office right now, as the other clients see them. */
export interface PersonPresence {
  /** One per open window: the same guest in two windows is two entries. */
  id: string;
  name: string;
  role: 'owner' | GuestRole;
  x: number;
  z: number;
  rot: number;
  moving: boolean;
  /** A stable colour and look derived from who they are. */
  hue: number;
}

const KV = 'guests';

type Rule = [method: string, path: RegExp];
const r = (method: string, pattern: string): Rule => [method, new RegExp(`^${pattern.replace(/:id/g, '[^/]+')}$`)];

const VISITOR: Rule[] = [r('GET', '/me'), r('GET', '/state'), r('GET', '/roles'), r('GET', '/events'), r('GET', '/performance'), r('GET', '/layout/capacity'), r('GET', '/radio/now'), r('GET', '/people')];
const COLLEAGUE: Rule[] = [
  ...VISITOR,
  r('GET', '/employees/:id/docs'),
  r('GET', '/employees/:id/docs/file'),
  r('GET', '/employees/:id/git'),
  r('GET', '/employees/:id/xp'),
  r('GET', '/tasks/:id/git'),
  r('GET', '/projects/:id/integration'),
  r('POST', '/employees/:id/message'),
  r('POST', '/employees/:id/report'),
  r('POST', '/tasks'),
  r('PATCH', '/tasks/:id'),
  r('POST', '/tasks/release'),
  r('POST', '/tasks/:id/unblock'),
  r('POST', '/meetings'),
  r('POST', '/lessons'),
  r('POST', '/commands/plan'),
  // Answers to questions only; the route itself refuses permission requests from a guest.
  r('POST', '/questions/:id/answer'),
];

/** May someone with this role call this owner-API route? (`path` is relative to /api, without the query.) */
export function guestMay(role: GuestRole, method: string, path: string): boolean {
  return (role === 'colleague' ? COLLEAGUE : VISITOR).some(([m, re]) => m === method && re.test(path));
}

export class Guests {
  private engine: Engine;
  private guests = new Map<string, Guest>();

  constructor(engine: Engine) {
    this.engine = engine;
    for (const g of engine.core.store.kvGet<Guest[]>(KV, [])) this.guests.set(g.id, g);
  }

  private save(): void {
    this.engine.core.store.kvSet(KV, [...this.guests.values()]);
  }

  list(): Guest[] {
    return [...this.guests.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Invite someone. The token is returned once, here; only its hash is stored. */
  invite(input: { name: string; role?: string }, actor = 'owner'): { guest: Guest; token: string } {
    const name = String(input.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) throw new EngineError('a guest needs a name');
    const role: GuestRole = input.role === 'colleague' ? 'colleague' : 'visitor';
    if ([...this.guests.values()].some((g) => !g.revokedAt && g.name.toLowerCase() === name.toLowerCase())) throw new EngineError(`there is already a guest called "${name}"`);
    const guest: Guest = { id: newId(), name, role, createdAt: nowIso(), lastSeenAt: null, revokedAt: null };
    const token = generateToken('orch_guest');
    this.engine.core.store.addCredential('guest', token, { refId: guest.id, label: name });
    this.guests.set(guest.id, guest);
    this.save();
    this.engine.core.audit(actor, 'guest.invited', guest.id, { name, role });
    return { guest, token };
  }

  /** A new invitation for an existing guest; the old one stops working. */
  reissue(id: string, actor = 'owner'): { guest: Guest; token: string } {
    const guest = this.require(id);
    if (guest.revokedAt) throw new EngineError(`${guest.name}'s access was revoked; invite them again`);
    this.engine.core.store.revokeCredentialsFor('guest', id);
    const token = generateToken('orch_guest');
    this.engine.core.store.addCredential('guest', token, { refId: id, label: guest.name });
    this.engine.core.audit(actor, 'guest.reissued', id, { name: guest.name });
    return { guest, token };
  }

  update(id: string, patch: { role?: string }, actor = 'owner'): Guest {
    const guest = this.require(id);
    if (patch.role === 'visitor' || patch.role === 'colleague') {
      guest.role = patch.role;
      this.save();
      this.engine.core.audit(actor, 'guest.role_changed', id, { name: guest.name, role: guest.role });
    }
    return guest;
  }

  revoke(id: string, actor = 'owner'): Guest {
    const guest = this.require(id);
    this.engine.core.store.revokeCredentialsFor('guest', id);
    guest.revokedAt = nowIso();
    this.save();
    this.engine.core.audit(actor, 'guest.revoked', id, { name: guest.name });
    return guest;
  }

  private require(id: string): Guest {
    const g = this.guests.get(id);
    if (!g) throw new EngineError('unknown guest', 404);
    return g;
  }

  /** The guest a token belongs to, if it is valid and not revoked. */
  byToken(token: string | null | undefined): Guest | null {
    const cred = this.engine.core.store.checkCredential('guest', token);
    const guest = cred?.refId ? this.guests.get(cred.refId) : undefined;
    return guest && !guest.revokedAt ? guest : null;
  }

  seen(id: string): void {
    const g = this.guests.get(id);
    if (!g) return;
    const now = Date.now();
    if (g.lastSeenAt && now - Date.parse(g.lastSeenAt) < 60_000) return;
    g.lastSeenAt = new Date(now).toISOString();
    this.save();
  }
}

/** A colour for a person, the same every time for the same identity. */
export function hueOf(identity: string): number {
  return crypto.createHash('sha1').update(identity).digest().readUInt16BE(0) % 360;
}
