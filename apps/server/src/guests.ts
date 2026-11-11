/**
 * Members: the people invited to the office. Each has a name, a role and a credential of their own
 * (an invitation), which can be revoked at any time and is never the server's own owner token.
 *
 *   visitor   — reads what is shared; changes nothing.
 *   colleague — works on everything shared and on what is on their own computer.
 *   owner     — everything.
 *
 * What each role may do is decided in `access.ts`. (The store and the API still say "guest" in
 * places — the name these people had before there were three roles.)
 */
import crypto from 'node:crypto';
import { newId, nowIso } from '@orchestrator/contracts';
import { generateToken } from '@orchestrator/database';
import { EngineError, type Engine } from '@orchestrator/orchestration';

import type { Who } from './access.ts';
export type { Who } from './access.ts';

export type GuestRole = 'visitor' | 'colleague' | 'owner';
const ROLES: GuestRole[] = ['visitor', 'colleague', 'owner'];
const roleOf = (r: unknown): GuestRole | null => (ROLES.includes(r as GuestRole) ? (r as GuestRole) : null);

export interface Guest {
  id: string;
  name: string;
  role: GuestRole;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** Let in at the door rather than invited: from the office's page in a browser, or from the desktop app. */
  via?: 'knock-browser' | 'knock-app';
  /** When this access ends by itself (a browser visit); null or absent: until revoked. */
  expiresAt?: string | null;
}

/** A member as the rest of the server sees whoever is making a request. */
export function whoIs(g: Guest): Who {
  return g.role === 'owner' ? { kind: 'owner', id: g.id, name: g.name, role: 'owner' } : { kind: 'guest', id: g.id, name: g.name, role: g.role };
}

/** Someone present in the office right now, as the other clients see them. */
export interface PersonPresence {
  /** One per open window: the same guest in two windows is two entries. */
  id: string;
  name: string;
  role: GuestRole;
  /** The member's id ('owner' for the root owner): their personal host carries the same id. */
  memberId: string;
  x: number;
  z: number;
  rot: number;
  moving: boolean;
  /** A stable colour and look derived from who they are. */
  hue: number;
}

const KV = 'guests';

/** A name as it is compared: without what cannot be seen (direction marks, zero-width characters), in one case. */
export const plainName = (name: string): string => name.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
/** A name as it is kept: the same, with its capitals. */
export const cleanName = (name: string): string => String(name ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();

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

  /**
   * Invite someone. The token is returned once, here; only its hash is stored. With `credential: false` no
   * token is made yet: the member gets one when their invitation link is used (`issue`).
   */
  invite(input: { name: string; role?: string; via?: Guest['via']; expiresAt?: string | null; credential?: boolean }, actor = 'owner'): { guest: Guest; token: string } {
    const name = cleanName(input.name).slice(0, 40);
    if (!name) throw new EngineError('a guest needs a name');
    const role: GuestRole = roleOf(input.role) ?? 'visitor';
    if (this.taken(name)) throw new EngineError(`there is already a guest called "${name}"`);
    const guest: Guest = { id: newId(), name, role, createdAt: nowIso(), lastSeenAt: null, revokedAt: null, ...(input.via ? { via: input.via } : {}), ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) };
    const token = input.credential === false ? '' : generateToken('orch_guest');
    if (token) this.engine.core.store.addCredential('guest', token, { refId: guest.id, label: name });
    this.guests.set(guest.id, guest);
    this.save();
    this.engine.core.audit(actor, 'guest.invited', guest.id, { name, role });
    return { guest, token };
  }

  /** The member's invitation link was used: their app is given a credential to keep. Any earlier one stops working. */
  issue(id: string): { guest: Guest; token: string } {
    const guest = this.require(id);
    if (guest.revokedAt) throw new EngineError(`${guest.name}'s access was revoked; invite them again`);
    this.engine.core.store.revokeCredentialsFor('guest', id);
    const token = generateToken('orch_guest');
    this.engine.core.store.addCredential('guest', token, { refId: id, label: guest.name });
    this.engine.core.audit(`member:${guest.name}`, 'guest.joined', id, { name: guest.name, role: guest.role });
    return { guest, token };
  }

  private taken(name: string): boolean {
    const n = plainName(name);
    return [...this.guests.values()].some((g) => !g.revokedAt && plainName(g.name) === n);
  }

  /**
   * Names somebody who knocks cannot have, besides other members': the ones people in the office already answer to —
   * the owner's, "Owner", every employee's. (A visitor called like the boss would speak in the chat under the boss's
   * name.) An owner's own invitation may name anybody: that is the owner's word, not the visitor's.
   */
  private answeredTo(name: string): boolean {
    const n = plainName(name);
    return [this.engine.core.settings.ownerName, 'Owner', 'The boss', 'Boss', 'Orchestrator', ...this.engine.core.employees.filter((e) => !e.archived).map((e) => e.name)].filter(Boolean).some((x) => plainName(String(x)) === n);
  }

  /** A name nobody in the office has: the one asked for, or that with a number after it. */
  freeName(wanted: string): string {
    const base = cleanName(wanted).slice(0, 36) || 'Guest';
    const free = (x: string) => !this.taken(x) && !this.answeredTo(x);
    if (free(base)) return base;
    for (let n = 2; n < 100; n++) if (free(`${base} ${n}`)) return `${base} ${n}`;
    return `${base} ${newId().slice(0, 4)}`;
  }

  /** Members whose time is up and who have not been shown out yet. */
  expired(now = Date.now()): Guest[] {
    return [...this.guests.values()].filter((g) => !g.revokedAt && !!g.expiresAt && Date.parse(g.expiresAt) <= now);
  }

  /** A new invitation for an existing guest; the old one stops working. (`credential: false`: as in `invite`.) */
  reissue(id: string, actor = 'owner', opts: { credential?: boolean } = {}): { guest: Guest; token: string } {
    const guest = this.require(id);
    if (guest.revokedAt) throw new EngineError(`${guest.name}'s access was revoked; invite them again`);
    this.engine.core.store.revokeCredentialsFor('guest', id);
    const token = opts.credential === false ? '' : generateToken('orch_guest');
    if (token) this.engine.core.store.addCredential('guest', token, { refId: id, label: guest.name });
    this.engine.core.audit(actor, 'guest.reissued', id, { name: guest.name });
    return { guest, token };
  }

  update(id: string, patch: { role?: string }, actor = 'owner'): Guest {
    const guest = this.require(id);
    const role = roleOf(patch.role);
    if (role && role !== guest.role) {
      guest.role = role;
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

  get(id: string): Guest | undefined {
    return this.guests.get(id);
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
    return guest && !guest.revokedAt && !(guest.expiresAt && Date.parse(guest.expiresAt) <= Date.now()) ? guest : null;
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
