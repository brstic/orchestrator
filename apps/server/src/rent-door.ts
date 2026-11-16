/**
 * The Rent portal's door (`docs/RENT.md`): how a client gets in, and everything they may ask of the office.
 *
 * A client is not a member. Their credential is of its own kind (`client`), which nothing else in the office takes: the
 * owner API, the office's WebSocket and the worker endpoint answer it as they answer a stranger. All a client reaches
 * is under `/rent/api`, and only the employees they rent.
 *
 *   GET  /r/:code             the portal, opened at an invitation link (the page asks `/rent/join/:code` whose it is)
 *   GET  /rent                the portal
 *   GET  /rent/join/:code     whose the link is: the office, the client's name, whom they rent (nothing is used up)
 *   POST /rent/join           the link and a password of their choosing → a session (the link is used up)
 *   /rent/api/…               with that session: me, the conversations, sending, files, their password, signing out
 *
 * The owner's side — making a client and a link, renting and releasing employees, what each may do, reading the
 * conversations — is under `/api/rent` (`ownerRoutes`), which needs an owner like every route not given to members.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LEAD_ROLE, type Employee, type RentClient, type RentLine } from '@orchestrator/contracts';
import { EngineError, type Engine } from '@orchestrator/orchestration';
import { Invites } from './invites.ts';
import { Logins } from './logins.ts';
import { plainName, type Guests } from './guests.ts';

export interface RentDoorDeps {
  engine: Engine;
  guests: Guests;
  /** The address people come to, as the owner set it (invitation links start with it). */
  address: () => string | null;
  /** Where a request comes from (for the limits on guessing). */
  addressOf: (req: FastifyRequest) => string;
  /** The page, with `<base href="/">` so that its files are found from any path. */
  page: () => string | null;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const MAX_CHUNK = 1024 * 1024;

export class RentDoor {
  readonly logins: Logins<RentClient>;
  readonly invites: Invites;
  private deps: RentDoorDeps;

  constructor(deps: RentDoorDeps) {
    this.deps = deps;
    const engine = deps.engine;
    this.logins = new Logins<RentClient>(engine, { get: (id) => engine.rent.get(id), list: () => engine.rent.list() }, Date.now, { kv: 'rent.logins', kind: 'client', label: 'client' });
    this.invites = new Invites(engine.core.store, Date.now, 'rent.invites');
  }

  private get engine() {
    return this.deps.engine;
  }

  /** Is this name somebody's who signs in at the door — a member, or the office's own names? */
  memberName(name: string): boolean {
    const n = plainName(name);
    return [this.engine.core.settings.ownerName, 'Owner', 'The boss', 'Boss', 'Orchestrator'].filter(Boolean).some((x) => plainName(String(x)) === n) || this.deps.guests.list().some((g) => !g.revokedAt && plainName(g.name) === n);
  }

  /** Is this the name of a client (so that signing in with it is a client's)? */
  isClient(name: unknown): boolean {
    return !!this.engine.rent.byName(String(name ?? ''));
  }

  /** The client a session token belongs to, if it is valid and they are still a client. */
  byToken(token: string | null): RentClient | null {
    const cred = token ? this.engine.core.store.checkCredential('client', token) : null;
    return this.engine.rent.active(cred?.refId);
  }

  /** A link for this client that works once, for a week: their way to set a password and come in. */
  link(clientId: string): { link: string; expiresAt: string } {
    const address = this.deps.address();
    if (!address) throw new EngineError('Save the address people come to first (Access → Members): the link starts with it.');
    const { code, expiresAt } = this.invites.create(clientId);
    return { link: `${address}/r/${code}`, expiresAt };
  }

  /** Everything the client came in with ends: sessions, password, the link. */
  private endAccess(clientId: string, actor: string): void {
    this.engine.core.store.revokeCredentialsFor('client', clientId);
    this.logins.clear(clientId, actor);
    this.invites.drop(clientId);
  }

  /** A client as the owner's window shows them. */
  view(c: RentClient) {
    const e = this.engine;
    return {
      ...c,
      hasPassword: this.logins.has(c.id),
      inviteExpiresAt: c.revokedAt ? null : this.invites.expiresAtOf(c.id),
      ...e.rent.summary(c),
      agents: c.rentals.map((r) => {
        const emp = e.core.employees.get(r.employeeId);
        return { ...r, name: emp?.name ?? '(gone)', title: emp?.title ?? '', appearance: emp?.appearance ?? null, workingDir: emp?.workingDir ?? null, state: emp ? e.rent.agentView(emp, r).state : 'away', mine: !!emp && !!e.hosts.memberOfHost(emp.hostId), online: !!emp?.hostId && e.core.agents.isOnline(emp.hostId) };
      }),
    };
  }

  /** A conversation's lines as a person is shown them: a client's line carries how far it got. */
  private shown(lines: RentLine[]) {
    return lines.map((l) => (l.messageId ? { ...l, delivery: this.engine.core.messages.get(l.messageId)?.delivery.status ?? 'confirmed' } : l));
  }

  // ───────────── the client's side ─────────────

  register(app: FastifyInstance): void {
    const engine = this.engine;
    const page = (_req: FastifyRequest, reply: FastifyReply) => {
      const html = this.deps.page();
      void reply.header('cache-control', 'no-store');
      return html ? reply.type('text/html; charset=utf-8').send(html) : reply.type('text/plain').send('The Rent portal is not built on this server.');
    };
    app.get('/rent', page);
    app.get('/r/:code', page);

    app.get('/rent/join/:code', async (req) => {
      const client = engine.rent.active(this.invites.peek(String((req.params as Record<string, string>).code).split('.')[0], this.deps.addressOf(req)));
      if (!client) throw new EngineError('This link is no longer valid. Ask for a new one.', 410);
      return { office: engine.core.settings.companyName, name: client.name, company: client.company, agents: engine.rent.agentsOf(client).map((x) => ({ name: x.name, title: x.title, appearance: x.appearance })) };
    });

    app.post('/rent/join', { bodyLimit: 4096 }, async (req, reply) => {
      void reply.header('cache-control', 'no-store');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const ip = this.deps.addressOf(req);
      const code = String(b.code ?? '').split('.')[0];
      const client = engine.rent.active(this.invites.peek(code, ip));
      if (!client) throw new EngineError('This link is no longer valid. Ask for a new one.', 410);
      // The password first: a link is used up only by somebody who got in with it.
      this.logins.set(client.id, b.password, `client:${client.name}`);
      this.invites.redeem(code, ip);
      engine.core.audit(`client:${client.name}`, 'rent.joined', client.id, { ip });
      const { token, expiresAt } = this.logins.session(client, ip);
      return { token, expiresAt, name: client.name, office: engine.core.settings.companyName };
    });

    app.register(
      async (api) => {
        api.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
          const h = req.headers.authorization;
          const client = this.byToken(h?.startsWith('Bearer ') ? h.slice(7).trim() : null);
          if (!client) return reply.code(401).send({ error: 'Sign in again.' });
          (req as unknown as { client: RentClient }).client = client;
          engine.rent.seen(client.id);
        });
        const clientOf = (req: FastifyRequest) => (req as unknown as { client: RentClient }).client;
        const param = (req: FastifyRequest, k: string) => String((req.params as Record<string, string>)[k] ?? '');
        /** An employee this client rents, and the terms; anything else is "no such employee". */
        const rented = (req: FastifyRequest): { client: RentClient; employee: Employee; files: boolean } => {
          const client = clientOf(req);
          const rental = client.rentals.find((r) => r.employeeId === param(req, 'eid'));
          const employee = rental ? engine.core.employees.get(rental.employeeId) : undefined;
          if (!rental || !employee || employee.archived) throw new EngineError('no such employee', 404);
          return { client, employee, files: rental.perms.files };
        };

        api.get('/me', async (req) => {
          const c = clientOf(req);
          return { office: engine.core.settings.companyName, name: c.name, company: c.company, agents: c.rentals.map((r) => ({ r, e: engine.core.employees.get(r.employeeId) })).filter((x) => x.e && !x.e.archived).map((x) => ({ ...engine.rent.agentView(x.e!, x.r), last: engine.rent.lines(c.id, x.e!.id).slice(-1)[0] ?? null })) };
        });
        api.get('/chats/:eid', async (req) => {
          const { client, employee } = rented(req);
          const after = String((req.query as Record<string, string>).after ?? '');
          const all = engine.rent.lines(client.id, employee.id);
          const seen = after ? all.findIndex((l) => l.id === after) : -1;
          const from = seen >= 0 ? seen + 1 : Math.max(0, all.length - 200);
          const rental = client.rentals.find((r) => r.employeeId === employee.id)!;
          const fresh = all.slice(from);
          // How far the client's last lines got (sent, then seen) is told again each time: it changes after they were shown.
          const pending = all.filter((l) => l.from === 'client' && l.messageId).slice(-12);
          // (The client's lines not yet taken in are sent again with how far they got; `whole`: these are all the lines from the start, not an addition.)
          return { agent: engine.rent.agentView(employee, rental), lines: this.shown(fresh), pending: this.shown(pending), whole: seen < 0, more: seen < 0 && from > 0 };
        });
        api.post('/chats/:eid', { bodyLimit: 64 * 1024 }, async (req) => {
          const { client, employee } = rented(req);
          const b = (req.body ?? {}) as Record<string, unknown>;
          const files = Array.isArray(b.files) ? b.files.map(String).slice(0, 10) : [];
          const line = await engine.rent.say(client.id, employee.id, b.text, files, `client:${client.id}`);
          return this.shown([line])[0];
        });
        api.post('/chats/:eid/files', async (req) => {
          const { client, employee, files } = rented(req);
          if (!files) throw new EngineError('files cannot be sent to this employee', 403);
          const b = (req.body ?? {}) as Record<string, unknown>;
          return engine.saidFiles.begin(employee.id, { name: String(b.name ?? ''), size: Number(b.size) }, `client:${client.id}`);
        });
        api.post('/chats/:eid/files/:fid/data', { bodyLimit: Math.ceil(MAX_CHUNK * 1.4) + 4096 }, async (req) => {
          const { client, employee, files } = rented(req);
          if (!files) throw new EngineError('files cannot be sent to this employee', 403);
          const b = (req.body ?? {}) as Record<string, unknown>;
          return engine.saidFiles.append(employee.id, param(req, 'fid'), Number(b.offset) || 0, Buffer.from(String(b.dataBase64 ?? ''), 'base64'), `client:${client.id}`);
        });
        api.get('/chats/:eid/files/:fid', async (req, reply) => {
          const { client, employee } = rented(req);
          // Only a file of this conversation: one the client sent, or one the employee gave them.
          if (!engine.rent.fileOf(client.id, employee.id, param(req, 'fid'))) throw new EngineError('no such file', 404);
          const { file, path: where } = engine.saidFiles.open(employee.id, param(req, 'fid'));
          const inline = /^(image\/(png|jpeg|gif|webp)|video\/mp4|audio\/mpeg|application\/pdf|text\/plain)$/.test(file.mime);
          return reply
            .header('content-type', file.mime)
            .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`)
            .header('cache-control', 'private, max-age=3600')
            .header('content-security-policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox")
            .send(fs.createReadStream(where));
        });
        api.post('/password', { bodyLimit: 2048 }, async (req) => {
          const c = clientOf(req);
          const b = (req.body ?? {}) as Record<string, unknown>;
          // Knowing the one they have: a browser left open is not enough to take the name over.
          await this.logins.check(c.name, b.current, this.deps.addressOf(req));
          this.logins.set(c.id, b.password, `client:${c.name}`);
          const { token, expiresAt } = this.logins.session(c, this.deps.addressOf(req));
          return { ok: true, token, expiresAt };
        });
        api.post('/logout', async (req) => {
          const h = req.headers.authorization;
          this.logins.signOut(h?.startsWith('Bearer ') ? h.slice(7).trim() : null);
          return { ok: true };
        });
      },
      { prefix: '/rent/api' },
    );
  }

  /** Signing in at the door with the name of a client: their session, and that it is a client's. */
  async signIn(username: unknown, password: unknown, ip: string) {
    const { guest: client, token, expiresAt } = await this.logins.signIn(username, password, ip);
    return { token, expiresAt, name: client.name, kind: 'client' as const, office: this.engine.core.settings.companyName };
  }

  // ───────────── the owner's side (under /api, owners only) ─────────────

  ownerRoutes(api: FastifyInstance, actorOf: (req: FastifyRequest) => string, memberOf: (req: FastifyRequest) => string): void {
    const engine = this.engine;
    const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
    const param = (req: FastifyRequest, k: string) => String((req.params as Record<string, string>)[k] ?? '');
    const all = (req: FastifyRequest) => {
      const me = memberOf(req);
      return {
        address: this.deps.address(),
        clients: engine.rent.list().map((c) => this.view(c)),
        // Whom this owner can rent out: those who do the work on the office's own machines, and on this owner's own
        // computer (they work while it is connected).
        employees: engine.core.employees
          .filter((e) => !e.archived && e.roleKey !== 'foreman' && e.roleKey !== LEAD_ROLE && !e.selfDriven && (!engine.hosts.memberOfHost(e.hostId) || engine.hosts.memberOfHost(e.hostId) === me))
          .map((e) => ({
            id: e.id,
            name: e.name,
            title: e.title,
            appearance: e.appearance,
            workingDir: e.workingDir,
            rentedTo: engine.rent.rentalOf(e.id)?.client.name ?? null,
            mine: !!engine.hosts.memberOfHost(e.hostId),
            online: !!e.hostId && engine.core.agents.isOnline(e.hostId),
            cannot: engine.rent.rentalOf(e.id) ? null : engine.rent.rentable(e, me),
          })),
      };
    };
    api.get('/rent', async (req) => all(req));
    api.post('/rent/clients', async (req) => {
      const b = body(req);
      const client = engine.rent.create(b, actorOf(req), (n) => this.memberName(n), memberOf(req));
      return { client: this.view(client), ...this.link(client.id) };
    });
    api.patch('/rent/clients/:id', async (req) => this.view(engine.rent.update(param(req, 'id'), body(req), actorOf(req), (n) => this.memberName(n))));
    api.delete('/rent/clients/:id', async (req) => {
      const client = engine.rent.revoke(param(req, 'id'), actorOf(req));
      this.endAccess(client.id, actorOf(req));
      return this.view(client);
    });
    // A new link: what the client came in with ends (sessions and password) — they set a password again with it.
    api.post('/rent/clients/:id/link', async (req) => {
      const client = engine.rent.get(param(req, 'id'));
      if (!engine.rent.active(client?.id)) throw new EngineError('unknown client', 404);
      this.endAccess(client!.id, actorOf(req));
      return { client: this.view(client!), ...this.link(client!.id) };
    });
    api.post('/rent/clients/:id/agents', async (req) => this.view(engine.rent.rent(param(req, 'id'), String(body(req).employeeId ?? ''), body(req).perms, actorOf(req), memberOf(req))));
    api.patch('/rent/clients/:id/agents/:eid', async (req) => this.view(engine.rent.setPerms(param(req, 'id'), param(req, 'eid'), body(req).perms, actorOf(req))));
    api.delete('/rent/clients/:id/agents/:eid', async (req) => this.view(engine.rent.release(param(req, 'id'), param(req, 'eid'), actorOf(req))));
    api.get('/rent/clients/:id/chats/:eid', async (req) => {
      if (!engine.rent.get(param(req, 'id'))) throw new EngineError('unknown client', 404);
      return { lines: this.shown(engine.rent.lines(param(req, 'id'), param(req, 'eid'))) };
    });
    api.get('/rent/clients/:id/chats/:eid/files/:fid', async (req, reply) => {
      if (!engine.rent.fileOf(param(req, 'id'), param(req, 'eid'), param(req, 'fid'))) throw new EngineError('no such file', 404);
      const { file, path: where } = engine.saidFiles.open(param(req, 'eid'), param(req, 'fid'));
      return reply.header('content-type', file.mime).header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`).send(fs.createReadStream(where));
    });
  }
}

/** The page at any path: its own files found from the root of the address. */
export function pageAt(uiDir: string | null): () => string | null {
  let cached: string | null = null;
  return () => {
    if (!uiDir) return null;
    if (cached) return cached;
    const file = path.join(uiDir, 'index.html');
    if (!fs.existsSync(file)) return null;
    cached = fs.readFileSync(file, 'utf8').replace(/<head>/i, '<head><base href="/">');
    return cached;
  };
}
