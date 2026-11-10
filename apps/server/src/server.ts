import { Door, inviteCode } from './door.ts';
import { Guests, whoIs, type Who } from './guests.ts';
import { Knocks, type Admission } from './knocks.ts';
import { allowed, eventFor, mayCall, mayReadRoutine, outcomesScopeFor, stateFor } from './access.ts';
import { HiFi, nowPlaying } from './radio.ts';
import { SshLinks } from './ssh-links.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ROLE_CATALOGUE } from '@orchestrator/contracts';
import { NotFoundError, PgStore, Store, generateToken, type Storage } from '@orchestrator/database';
import { handleMcpPost } from '@orchestrator/integrations';
import { Engine, EngineError, type Timings } from '@orchestrator/orchestration';
import { AgentHub, ClientHub } from './hubs.ts';

export interface ServerOptions {
  /** Directory for the database, owner token and local enrollment token. */
  dataDir: string;
  /** postgres:// URL. When set, PostgreSQL is used instead of the SQLite file in dataDir. */
  database?: string | null;
  host: string;
  port: number;
  /** URL workers use to reach this server (MCP). Defaults to http://<host>:<port>. */
  publicUrl?: string;
  tls?: { certFile: string; keyFile: string } | null;
  /** Built UI to serve, if present. */
  uiDir?: string | null;
  /** Skip the "non-loopback requires TLS" guard (e.g. TLS terminates at a reverse proxy). */
  allowInsecureRemote?: boolean;
  timings?: Partial<Timings>;
  quiet?: boolean;
}

export interface RunningServer {
  app: FastifyInstance;
  engine: Engine;
  url: string;
  ownerToken: string;
  /** One-time enrollment token for an agent on this same machine (local mode). */
  localEnrollToken: () => string;
  close: () => Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** `curl -fsSL <server>/install-agent.sh | sh` — installs the host agent for the current user. */
function installScript(serverUrl: string): string {
  return `#!/bin/sh
# Installs the Orchestrator host agent for the current user (no root needed).
set -eu
SERVER="${serverUrl}"
DEST="\${ORCH_INSTALL_DIR:-$HOME/.orchestrator/bin}"
need() { command -v "$1" >/dev/null 2>&1 || { echo "error: $1 is required: $2" >&2; exit 1; }; }
need node "install Node.js 22.18 or newer"
need tmux "employees run inside tmux sessions"
need curl "used by Claude Code hooks to reach the agent"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' || { echo "error: Node.js 22.18+ is required (found $(node -v))" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || echo "warning: the claude CLI is not on PATH; install Claude Code before starting employees here."
command -v git >/dev/null 2>&1 || echo "warning: git is not installed; employees need it to work in worktrees."
mkdir -p "$DEST"
curl -fsSL "$SERVER/downloads/orchestrator-agent.mjs" -o "$DEST/orchestrator-agent.mjs"
printf '#!/bin/sh\nexec node "%s/orchestrator-agent.mjs" "$@"\n' "$DEST" > "$DEST/orchestrator-agent"
chmod +x "$DEST/orchestrator-agent"
echo
echo "Installed $DEST/orchestrator-agent"
case ":$PATH:" in *":$DEST:"*) ;; *) echo "Add it to your PATH:  export PATH=$DEST:\\$PATH" ;; esac
echo "Next (the enrollment token comes from the office: Machines -> Connect a machine):"
echo "  orchestrator-agent login --server $SERVER --token <enrollment-token>"
echo "  orchestrator-agent connect            # or: orchestrator-agent service install"
`;
}

export function defaultDataDir(): string {
  return process.env.ORCH_SERVER_HOME ? path.resolve(process.env.ORCH_SERVER_HOME) : path.join(os.homedir(), '.orchestrator', 'server');
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isLoopbackAddress(addr: string | undefined): boolean {
  return !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = (level: 'info' | 'warn' | 'error', msg: string) => {
    if (!opts.quiet || level === 'error') console.error(`[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`);
  };
  if (!isLoopbackHost(opts.host) && !opts.tls && !opts.allowInsecureRemote) {
    throw new Error(`refusing to listen on ${opts.host} without TLS. Provide --tls-cert/--tls-key, or --allow-insecure-remote if TLS terminates at a reverse proxy in front of this server.`);
  }
  fs.mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const store: Storage = opts.database ? await PgStore.open(opts.database, { log }) : new Store(path.join(opts.dataDir, 'orchestrator.db'));
  if (opts.database) log('info', `using PostgreSQL: ${store.file}`);

  // Owner token: generated once, stored hashed in the database and in a 0600 file for local clients.
  const tokenFile = path.join(opts.dataDir, 'owner-token');
  let ownerToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  if (!ownerToken || !store.checkCredential('owner', ownerToken)) {
    ownerToken = generateToken('orch_owner');
    store.addCredential('owner', ownerToken, { label: 'owner' });
    fs.writeFileSync(tokenFile, ownerToken + '\n', { mode: 0o600 });
  }

  const scheme = opts.tls ? 'https' : 'http';
  const agents = new AgentHub(log);
  const clients = new ClientHub(log);
  const publicUrl = (opts.publicUrl ?? `${scheme}://${isLoopbackHost(opts.host) ? '127.0.0.1' : opts.host}:${opts.port}`).replace(/\/+$/, '');
  const engine = new Engine({ store, agents, publicUrl, timings: opts.timings, log }, { send: (clientId, msg) => clients.send(clientId, msg) });
  agents.attach(engine);
  clients.attach(engine);
  // The office's hi-fi: what is on is told to every window, and follows the list of stations when an owner edits it.
  const hifi = new HiFi(() => engine.core.settings.radio.stations, (now) => clients.radio(now));
  engine.core.bus.on('entity', (kind: string) => {
    if (kind === 'settings') hifi.stationsChanged();
  });
  engine.start();

  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    ...(opts.tls ? { https: { cert: fs.readFileSync(opts.tls.certFile), key: fs.readFileSync(opts.tls.keyFile) } } : {}),
  } as any) as unknown as FastifyInstance;
  // A window's WebSocket carries its token as a subprotocol ("orch.token.<token>") next to "orch.v1", which is the one
  // the server agrees to: a browser cannot set headers on a WebSocket, and a token in the address would end up in the
  // access log of every proxy on the way.
  await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 * 1024, handleProtocols: (protocols: Set<string>) => (protocols.has('orch.v1') ? 'orch.v1' : false) } });

  const tokenOf = (req: FastifyRequest): string | null => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) return h.slice(7).trim();
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).find((p) => p.startsWith('orch.token.'));
    if (offered) return offered.slice('orch.token.'.length);
    // In the address: the link a local office prints for a browser on the same computer, and older clients.
    const q = (req.query as any)?.token;
    return typeof q === 'string' ? q : null;
  };
  const guests = new Guests(engine);
  let door: Door | null = null;
  /** Did this request come in through the guest door (from the network), rather than from this computer? */
  const viaDoor = (req: FastifyRequest): boolean => !!door && req.headers['x-orch-door'] === door.secret;
  /** Who is asking: the root owner (never through the door), a member, or nobody. */
  const identify = (req: FastifyRequest): Who | null => {
    const token = tokenOf(req);
    if (!token) return null;
    if (!viaDoor(req) && store.checkCredential('owner', token)) return { kind: 'owner', id: 'owner', name: engine.core.settings.ownerName || 'Owner', role: 'owner' };
    const guest = guests.byToken(token);
    if (!guest) return null;
    guests.seen(guest.id);
    return whoIs(guest);
  };
  const whoOf = (req: FastifyRequest): Who => (req as unknown as { who: Who }).who;

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof EngineError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err?.validation || err?.statusCode === 400) return reply.code(400).send({ error: err.message });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    log('error', `request failed: ${err?.stack ?? err}`);
    return reply.code(500).send({ error: 'internal error' });
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
  });

  if (process.env.ORCH_DEBUG_HTTP) {
    // Opt-in request trace for diagnosing client integrations. Never logs credentials.
    app.addHook('onResponse', async (req, reply) => {
      const auth = req.headers.authorization;
      console.error(`[http] ${req.method} ${req.url.split('?')[0]} → ${reply.statusCode} auth=${auth ? auth.split(' ')[0] : 'none'} accept=${req.headers.accept ?? '-'} body=${req.method === 'POST' ? JSON.stringify((req.body as any)?.method ?? null) : '-'}`);
    });
  }

  app.get('/healthz', async () => ({ ok: true, name: 'orchestrator', version: '0.1.0' }));

  // ───────────── Knocking at the door (no credential: nothing is granted here) ─────────────
  /** How long someone let in from a browser may stay before they have to knock again. */
  const BROWSER_VISIT_MS = 12 * 3600_000;
  const showOut = (memberId: string) => {
    const g = guests.get(memberId);
    if (!g || g.revokedAt) return;
    guests.revoke(memberId, 'system');
    clients.dropGuest(memberId);
    for (const x of engine.hosts.ofMember(memberId)) engine.hosts.revoke(x.id, 'system');
  };
  const knocks = new Knocks({ onChange: () => clients.knocks(knocks.list()), takeBack: showOut });
  // Browser visits end by themselves.
  const visits = setInterval(() => {
    for (const g of guests.expired()) showOut(g.id);
  }, 30_000);
  visits.unref();
  /** Knocking exists only where the office is open to people from outside: through its door. */
  const atDoor = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (viaDoor(req)) return true;
    void reply.code(404).send({ error: 'not found' });
    return false;
  };
  const knockSecret = (req: FastifyRequest): unknown => req.headers['x-knock-secret'];
  app.get('/knock', async (req, reply) => {
    if (!atDoor(req, reply)) return reply;
    return { orchestrator: true, office: engine.core.settings.companyName };
  });
  app.post('/knock', { bodyLimit: 2048 }, async (req, reply) => {
    if (!atDoor(req, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const k = knocks.knock({ name: b.name, via: b.via, ip: String(req.headers['x-forwarded-for'] ?? req.ip) });
    return { ...k, office: engine.core.settings.companyName, anyoneIn: clients.someoneToAnswer() };
  });
  app.get('/knock/:id', async (req, reply) => {
    if (!atDoor(req, reply)) return reply;
    void reply.header('cache-control', 'no-store');
    const answer = knocks.poll(String((req.params as any).id), knockSecret(req));
    return answer.status === 'waiting' ? { ...answer, anyoneIn: clients.someoneToAnswer() } : answer;
  });
  app.delete('/knock/:id', async (req, reply) => {
    if (!atDoor(req, reply)) return reply;
    knocks.leave(String((req.params as any).id), knockSecret(req));
    return { ok: true };
  });

  // ───────────── WebSockets ─────────────
  app.get('/ws/agent', { websocket: true }, (socket, req) => agents.handle(socket as any, isLoopbackAddress(req.socket.remoteAddress), viaDoor(req)));
  app.get('/ws/client', { websocket: true }, (socket, req) => {
    const who = identify(req);
    if (!who) {
      (socket as any).close(4003, 'unauthorized');
      return;
    }
    clients.handle(socket as any, who);
  });

  // ───────────── MCP (authenticated per worker session) ─────────────
  app.post('/mcp', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const session = engine.sessions.sessionByMcpToken(tokenOf(req));
    const employee = session ? engine.core.employees.get(session.employeeId) : undefined;
    if (!session || !employee) return reply.code(401).header('www-authenticate', 'Bearer').send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: invalid or expired Orchestrator session token' } });
    const res = await handleMcpPost(req.body, engine.mcp, { session, employee });
    if (res.body === null) return reply.code(res.status).send();
    return reply.code(res.status).header('content-type', 'application/json').send(res.body);
  });
  // This server answers every POST with plain JSON; it offers no server-initiated stream.
  app.get('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'method not allowed' }));
  app.delete('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'method not allowed' }));

  let sshLinks: SshLinks | null = null;

  // ───────────── Owner API ─────────────
  await app.register(async (api) => {
    // Requests that present a wrong owner token: a handful in a minute is somebody guessing, and the owner is told.
    const wrongTokens: number[] = [];
    api.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      const who = identify(req);
      if (who) {
        (req as unknown as { who: Who }).who = who;
        if (who.id === 'owner') return;
        // A member: what their role allows, on what is shared or theirs. What they change is on the record under their name.
        const route = (req.url.split('?')[0] ?? '').replace(/^\/api/, '');
        const verdict = mayCall(engine, who, req.method, route, req.body as Record<string, unknown> | null);
        if (!verdict.ok) return reply.code(403).send({ error: verdict.reason });
        if (req.method !== 'GET') engine.core.audit(`member:${who.name}`, 'member.action', route, { method: req.method, role: who.role });
        return;
      }
      if (req.headers.authorization) {
        const now = Date.now();
        while (wrongTokens.length && now - wrongTokens[0]! > 60_000) wrongTokens.shift();
        if (wrongTokens.push(now) >= 5) {
          engine.core.audit('unknown', 'owner.auth_failed', '-', { attempts: wrongTokens.length, from: req.ip });
          engine.comms.securityAlert({
            key: 'owner-auth',
            severity: 'critical',
            title: 'Repeated attempts to use the office with a wrong owner token',
            body: `${wrongTokens.length} requests in the last minute presented an owner token that is not valid (most recently from ${req.ip}). None was let in. If this was not one of your own devices, rotate the owner token.`,
            data: { attempts: wrongTokens.length, from: req.ip },
          });
        }
      }
      return reply.code(401).send({ error: 'unauthorized' });
    });
    const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, any>;
    const param = (req: FastifyRequest, key: string) => String((req.params as any)[key]);
    const query = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string>;

    api.get('/state', async (req) => stateFor(engine, whoOf(req), engine.state()));
    // The percentages are for everyone in the office (the clocks on the walls); the account's e-mail and organisation
    // only for those who may work on the machine it lives on — its member and owners, or colleagues for a shared machine.
    api.get('/usage', async (req) => engine.sessions.accountUsage().map((a) => (allowed(whoOf(req), 'work', engine.hosts.memberOfHost(a.hostId)) ? a : { ...a, email: null, organization: null })));
    // The foreman: who it is, the round in flight and the last ones, and what needs attention right now (owner only).
    api.get('/foreman', async () => engine.foreman.status());
    api.get('/me', async (req) => ({ kind: whoOf(req).kind, role: whoOf(req).role, name: whoOf(req).name, id: whoOf(req).id, office: engine.core.settings.companyName }));
    api.get('/people', async () => clients.people());
    // A member's own computer: a one-time enrollment for the host agent their desktop app runs while they are here.
    api.post('/me/host', async (req) => {
      const who = whoOf(req);
      if (who.id === 'owner') throw new EngineError('This is the office\'s own computer already; its sessions are the shared ones.');
      return { ...engine.hosts.createMemberEnrollment({ id: who.id, name: who.name }), hosts: engine.hosts.ofMember(who.id).map((x) => ({ id: x.id, name: x.name, status: x.status })) };
    });
    // How a member wants their own room (size, colour, name, furniture): theirs to decide.
    api.get('/me/room', async (req) => engine.hosts.memberRoom(whoOf(req).id) ?? {});
    api.put('/me/room', async (req) => {
      const who = whoOf(req);
      if (who.id === 'owner') throw new EngineError('The office\'s own computer has no room of its own; rooms belong to members who connect.');
      return engine.hosts.setMemberRoom(who.id, body(req), `member:${who.name}`);
    });
    /** Someone who may no longer have a computer in the office (revoked, or now a visitor): theirs are disconnected for good. */
    const dropHostsOf = (memberId: string) => {
      for (const x of engine.hosts.ofMember(memberId)) engine.hosts.revoke(x.id, 'system');
    };

    // ── guests and the door they come in through (owner only: not in any guest's allowed routes) ──
    const sharing = () => ({ door: door?.status() ?? { open: false, port: null, addresses: [], fingerprint: null, error: 'the server is still starting' }, wanted: store.kvGet<{ open: boolean; port: number; address: string | null }>('sharing', { open: false, port: 4610, address: null }), guests: guests.list(), present: clients.people() });
    const invitation = (guest: { name: string; role: string }, token: string) => {
      const st = door!.status();
      const extra = store.kvGet<{ address: string | null }>('sharing', { address: null }).address;
      return inviteCode({ office: engine.core.settings.companyName, guest: guest.name, role: guest.role, token, addresses: [...new Set([...(extra ? [extra] : []), ...st.addresses])], fingerprint: st.fingerprint ?? '' });
    };
    const needDoor = () => {
      if (!door?.status().open) throw new EngineError('open the office to guests first (the guest door is closed)');
    };
    api.get('/sharing', async () => sharing());
    api.post('/sharing', async (req) => {
      if (!door) throw new EngineError('the server is still starting', 503);
      const b = body(req);
      const current = store.kvGet<{ open: boolean; port: number; address: string | null }>('sharing', { open: false, port: 4610, address: null });
      const port = b.port !== undefined ? Number(b.port) : current.port;
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new EngineError('choose a port between 1024 and 65535');
      let address = current.address;
      if (b.address !== undefined) {
        address = String(b.address ?? '').trim().replace(/\/+$/, '') || null;
        if (address && !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(address)) throw new EngineError('the extra address must look like https://name-or-ip:port');
      }
      const open = b.open !== undefined ? b.open === true : current.open;
      if (open) await door.open(port);
      else await door.close();
      store.kvSet('sharing', { open, port, address });
      engine.core.audit('owner', open ? 'sharing.opened' : 'sharing.closed', 'door', { port, address });
      return sharing();
    });
    // ── the door bell: who is waiting, and letting them in or not ──
    // An owner lets someone in as anything; a colleague only to look around. Someone who came with a browser can only look.
    api.get('/knocks', async () => knocks.list());
    api.post('/knocks/:id/admit', async (req) => {
      needDoor();
      const who = whoOf(req);
      const asked = String(body(req).role ?? 'visitor');
      if (!['visitor', 'colleague', 'owner'].includes(asked)) throw new EngineError('let them in as a visitor, a colleague or an owner');
      if (asked !== 'visitor' && who.kind !== 'owner') throw new EngineError('Only an owner of this office can let someone in to work; you can let them in to look around.', 403);
      const actor = who.id === 'owner' ? 'owner' : `member:${who.name}`;
      const k = knocks.admit(param(req, 'id'), (knock): Admission => {
        const role = knock.via === 'browser' ? 'visitor' : (asked as Admission['role']);
        const expiresAt = knock.via === 'browser' ? new Date(Date.now() + BROWSER_VISIT_MS).toISOString() : null;
        const { guest, token } = guests.invite({ name: guests.freeName(knock.name), role, via: knock.via === 'browser' ? 'knock-browser' : 'knock-app', expiresAt }, actor);
        return { role, name: guest.name, token, invite: invitation(guest, token), expiresAt, memberId: guest.id };
      });
      engine.core.audit(actor, 'knock.admitted', k.id, { name: k.name, via: k.via, as: k.via === 'browser' ? 'visitor' : asked });
      return { ok: true };
    });
    api.post('/knocks/:id/refuse', async (req) => {
      const who = whoOf(req);
      const k = knocks.refuse(param(req, 'id'));
      engine.core.audit(who.id === 'owner' ? 'owner' : `member:${who.name}`, 'knock.refused', k.id, { name: k.name, via: k.via });
      return { ok: true };
    });
    api.post('/guests', async (req) => {
      needDoor();
      const { guest, token } = guests.invite({ name: String(body(req).name ?? ''), role: body(req).role });
      return { guest, invite: invitation(guest, token) };
    });
    api.post('/guests/:id/reissue', async (req) => {
      needDoor();
      const { guest, token } = guests.reissue(param(req, 'id'));
      clients.dropGuest(guest.id);
      return { guest, invite: invitation(guest, token) };
    });
    api.patch('/guests/:id', async (req) => {
      const guest = guests.update(param(req, 'id'), { role: body(req).role });
      clients.dropGuest(guest.id); // they come back in with the new role
      if (guest.role === 'visitor') dropHostsOf(guest.id);
      return guest;
    });
    api.delete('/guests/:id', async (req) => {
      const guest = guests.revoke(param(req, 'id'));
      clients.dropGuest(guest.id);
      dropHostsOf(guest.id);
      return guest;
    });
    api.get('/roles', async () => ROLE_CATALOGUE);
    api.get('/audit', async (req) => store.recentAudit(Number(query(req).limit) || 200));
    api.get('/events', async (req) => {
      const q = query(req);
      const found = await store.queryEvents({ employeeId: q.employeeId, taskId: q.taskId, sessionId: q.sessionId, projectId: q.projectId, since: q.since, beforeSeq: q.before ? Number(q.before) : undefined, limit: q.limit ? Number(q.limit) : 200, excludeTypes: q.includeActivity ? undefined : ['session.activity', 'terminal.output'] });
      // What happened on a member's own computer is theirs and the owners' to read.
      const who = whoOf(req);
      return who.kind === 'owner' ? found : found.map((e) => eventFor(engine, who, e)).filter(Boolean);
    });
    api.post('/seen', async () => {
      engine.commands.touchLastSeen();
      return { ok: true };
    });
    api.get('/projects/:id/integration', async (req) => engine.tasks.integrationView(param(req, 'id')));
    api.post('/projects/:id/integration/sync', async (req) => engine.tasks.syncIntegration(param(req, 'id')));
    api.post('/projects/:id/integration/test', async (req) => engine.tasks.runIntegrationTests(param(req, 'id')));
    api.post('/projects/:id/promote', async (req) => engine.tasks.promote(param(req, 'id'), { force: body(req).force === true }));
    api.get('/radio/now', async (req) => {
      const station = engine.core.settings.radio.stations.find((s) => s.id === String(query(req).station ?? ''));
      return { text: station?.nowPlayingUrl ? await nowPlaying(station.nowPlayingUrl) : null };
    });
    // The hi-fi plays for the whole office. Owners and colleagues switch it (`access.ts`); the station is one of the saved ones.
    api.get('/radio', async () => ({ radio: hifi.current }));
    api.post('/radio/play', async (req) => {
      const who = whoOf(req);
      const now = hifi.play({ stationId: body(req).stationId, url: body(req).url }, { id: who.id, name: who.name });
      if (!now) throw new EngineError('That station is not in the office\'s list. An owner can add it at the hi-fi.', 404);
      if (engine.core.settings.radio.lastStationId !== now.station.id) engine.core.updateSettings({ radio: { ...engine.core.settings.radio, lastStationId: now.station.id } });
      return { radio: now };
    });
    api.post('/radio/stop', async () => {
      hifi.stop();
      return { radio: null };
    });
    api.patch('/settings', async (req) => {
      const patch = body(req) as Record<string, unknown>;
      const before = engine.core.settings as unknown as Record<string, unknown>;
      const after = engine.core.updateSettings(patch as any);
      // Settings decide, among other things, whether workers inherit the owner's connectors and
      // whether the office may learn on its own: every owner change is on the record.
      const changed = Object.keys(patch).filter((k) => JSON.stringify(before[k]) !== JSON.stringify((after as unknown as Record<string, unknown>)[k]));
      if (changed.length) {
        engine.core.audit('owner', 'settings.changed', 'settings', {
          changed,
          ...(changed.includes('workersInheritMcp') ? { workersInheritMcp: after.workersInheritMcp } : {}),
          ...(changed.includes('selfImprovement') ? { selfImprovement: after.selfImprovement } : {}),
          ...(changed.includes('foreman') ? { foreman: after.foreman } : {}),
        });
      }
      return after;
    });
    api.put('/layout', async (req) => engine.updateLayout(body(req) as any));
    api.get('/layout/capacity', async () => ({ desks: engine.core.layout.desks.length, freePodSlots: engine.freePodSlots() }));
    api.post('/layout/pods', async () => engine.addDeskPod());
    api.delete('/layout/desks/:id', async (req) => engine.removeDesk(param(req, 'id')));
    api.post('/layout/pods/:id/desks', async (req) => engine.addSeat(param(req, 'id')));
    api.put('/layout/pods/:id/label', async (req) => engine.setPodLabel(param(req, 'id'), String(body(req).label ?? '')));

    // employees
    api.post('/employees', async (req) => engine.hire(body(req) as any));
    api.patch('/employees/:id', async (req) => engine.employees.update(param(req, 'id'), body(req)));
    api.post('/employees/:id/start', async (req) => engine.sessions.start(param(req, 'id'), { resume: body(req).resume !== false, cwd: body(req).cwd ?? null, continueLast: body(req).continueLast === true }));
    api.post('/employees/:id/stop', async (req) => {
      await engine.sessions.stop(param(req, 'id'), { reason: 'stopped by the owner' });
      return { ok: true };
    });
    api.post('/employees/:id/pause', async (req) => {
      await engine.sessions.pause(param(req, 'id'));
      return { ok: true };
    });
    api.post('/employees/:id/resume', async (req) => {
      await engine.sessions.resume(param(req, 'id'));
      return { ok: true };
    });
    api.post('/employees/:id/message', async (req) => {
      const text = String(body(req).body ?? '').trim();
      if (!text) throw new EngineError('message is empty');
      // From a colleague, the employee is told who is speaking: it is not the boss.
      const who = whoOf(req);
      return engine.comms.sendMessage({ from: { kind: 'owner', id: null, name: who.kind === 'owner' ? (who.id === 'owner' ? 'the boss' : `${who.name} (an owner of this office)`) : `${who.name} (a colleague the boss invited; not the boss)` }, toEmployeeId: param(req, 'id'), body: text });
    });
    // Routines: a standing instruction the office repeats for one employee (see `routines.ts`).
    const actorOf = (req: FastifyRequest) => (whoOf(req).id === 'owner' ? 'owner' : `member:${whoOf(req).name}`);
    api.get('/routines', async (req) => engine.routines.list().filter((r) => mayReadRoutine(engine, whoOf(req), r)));
    api.post('/routines', async (req) => engine.routines.create(body(req), actorOf(req)));
    api.patch('/routines/:id', async (req) => engine.routines.update(param(req, 'id'), body(req), actorOf(req)));
    api.delete('/routines/:id', async (req) => {
      engine.routines.remove(param(req, 'id'), actorOf(req));
      return { ok: true };
    });
    api.post('/routines/:id/run', async (req) => engine.routines.runNow(param(req, 'id'), actorOf(req)));
    api.post('/employees/:id/report', async (req) => engine.commands.execute({ input: 'request report', interpretedBy: 'rules', operations: [{ operation: { op: 'employee.report', employeeId: param(req, 'id') }, description: 'Request a status report' }], problems: [] }));
    api.get('/employees/:id/git', async (req) => engine.tasks.gitView({ employeeId: param(req, 'id') }));
    api.get('/employees/:id/xp', async (req) => engine.core.xp.filter((x) => x.employeeId === param(req, 'id')).sort((a, b) => (a.ts < b.ts ? 1 : -1)));

    // sessions & hosts
    api.post('/sessions/attach', async (req) => {
      const b = body(req);
      return engine.sessions.attach(String(b.hostId), String(b.tmuxSession), b.tmuxPane ?? null, b.employeeId ?? null);
    });
    api.post('/sessions/:id/adopt', async (req) => engine.sessions.adopt(param(req, 'id')));
    api.post('/sessions/:id/bind', async (req) => engine.sessions.bind(param(req, 'id'), String(body(req).employeeId)));
    api.get('/sessions/:id/history', async (req) => {
      const s = engine.core.sessions.require(param(req, 'id'));
      return engine.core.agents.rpc(s.hostId, { method: 'term.history', params: { sessionId: s.id, lines: Number(query(req).lines) || 2000 } });
    });
    api.post('/hosts/enroll-token', async (req) => engine.hosts.createEnrollmentToken(String(body(req).label ?? 'host'), Number(body(req).ttlMinutes ?? 60) * 60_000));
    api.get('/hosts/:id/browse', async (req) => engine.core.agents.rpc(param(req, 'id'), { method: 'fs.browse', params: { path: query(req).path ? String(query(req).path) : null } }));
    api.get('/employees/:id/docs', async (req) => engine.documents(param(req, 'id')));
    api.get('/employees/:id/docs/file', async (req) => engine.document(param(req, 'id'), String(query(req).path ?? '')));
    // Servers linked over SSH (see ssh-links.ts). The manager exists once the server is listening.
    const links = (): SshLinks => {
      if (!sshLinks) throw new EngineError('the server is still starting', 503);
      return sshLinks;
    };
    api.get('/ssh-links', async () => links().list());
    api.post('/ssh-links/probe', async (req) => links().probe(String(body(req).target ?? ''), body(req).trustNewHost === true));
    api.post('/ssh-links', async (req) => links().add({ target: String(body(req).target ?? ''), name: body(req).name ? String(body(req).name) : undefined, roots: Array.isArray(body(req).roots) ? body(req).roots.map(String) : undefined, trustNewHost: body(req).trustNewHost === true }));
    api.post('/ssh-links/:id/connect', async (req) => links().connect(param(req, 'id'), { trustNewHost: body(req).trustNewHost === true }));
    api.post('/ssh-links/:id/disconnect', async (req) => links().disconnect(param(req, 'id')));
    api.delete('/ssh-links/:id', async (req) => links().remove(param(req, 'id')));
    api.get('/hosts/:id/claude-processes', async (req) => engine.core.agents.rpc(param(req, 'id'), { method: 'proc.claude', params: {} }));
    api.get('/hosts/:id/discover', async (req) => engine.core.agents.rpc(param(req, 'id'), { method: 'tmux.discover', params: {} }));
    api.post('/hosts/:id/revoke', async (req) => {
      engine.hosts.revoke(param(req, 'id'));
      return { ok: true };
    });
    api.patch('/hosts/:id', async (req) => engine.hosts.rename(param(req, 'id'), String(body(req).name ?? '')));
    api.delete('/hosts/:id', async (req) => {
      engine.hosts.remove(param(req, 'id'));
      return { ok: true };
    });

    // projects & tasks
    api.post('/projects', async (req) => engine.tasks.createProject(body(req) as any));
    api.patch('/projects/:id', async (req) => engine.tasks.updateProject(param(req, 'id'), body(req)));
    api.post('/projects/:id/pause', async (req) => ({ interrupted: await engine.pauseProject(param(req, 'id')) }));
    api.post('/projects/:id/resume', async (req) => engine.tasks.updateProject(param(req, 'id'), { status: 'active' }));
    api.post('/projects/:id/plan', async (req) => engine.tasks.planProject(param(req, 'id'), String(body(req).objective ?? ''), String(body(req).plannerId)));
    api.post('/tasks', async (req) => engine.tasks.createTask(body(req) as any));
    api.post('/tasks/release', async (req) => engine.tasks.release(body(req).ids ?? []));
    api.patch('/tasks/:id', async (req) => engine.tasks.updateTask(param(req, 'id'), body(req)));
    api.delete('/tasks/:id', async (req) => {
      engine.tasks.deleteTask(param(req, 'id'));
      return { ok: true };
    });
    api.post('/tasks/:id/review', async (req) => {
      const b = body(req);
      if (b.verdict !== 'approve' && b.verdict !== 'request_changes') throw new EngineError('verdict must be approve or request_changes');
      return engine.tasks.submitReview('owner', param(req, 'id'), b.verdict, String(b.comments ?? ''));
    });
    api.post('/tasks/:id/unblock', async (req) => engine.tasks.unblock(param(req, 'id'), String(body(req).note ?? '')));
    api.post('/tasks/:id/retry-merge', async (req) => engine.tasks.retryMerge(param(req, 'id')));
    api.get('/tasks/:id/git', async (req) => engine.tasks.gitView({ taskId: param(req, 'id') }));

    // questions, notifications, meetings
    api.post('/questions/:id/answer', async (req) => {
      // Whoever may work with this employee may answer it and decide its requests (`access.ts`); the record says who did.
      const who = whoOf(req);
      return engine.comms.answer(param(req, 'id'), body(req), who.id === 'owner' ? 'owner' : `member:${who.name}`);
    });
    api.post('/notifications/read', async (req) => {
      engine.comms.markRead(body(req).ids ?? 'all');
      return { ok: true };
    });
    api.post('/notifications/:id/resolve', async (req) => {
      engine.comms.resolveNotifications((n) => n.id === param(req, 'id'));
      return { ok: true };
    });
    api.post('/meetings', async (req) => engine.meetings.create(body(req) as any));
    api.post('/meetings/:id/cancel', async (req) => engine.meetings.cancel(param(req, 'id')));

    // self-improvement: playbooks, shared knowledge and Orchestrator's own suggestions
    api.post('/lessons', async (req) => engine.improver.recordFromOwner(body(req) as any));
    api.patch('/lessons/:id', async (req) => engine.improver.updateLesson(param(req, 'id'), body(req)));
    api.get('/performance', async () => engine.improver.performance());
    api.post('/improvements/analyze', async () => engine.improver.analyze());
    api.post('/improvements/:id/apply', async (req) => engine.improver.apply(param(req, 'id')));
    api.post('/improvements/:id/dismiss', async (req) => engine.improver.dismiss(param(req, 'id')));
    // the playbook: undo an automatic merge or promotion, by the id of the learning.* event that recorded it (owners only)
    api.post('/playbook/revert', async (req) => engine.improver.playbook.revert(String(body(req).eventId ?? '')));
    // Whether what was learned helped: trends, and a verdict per lesson and per applied improvement — from what the asker may see.
    api.get('/growth/outcomes', async (req) => engine.improver.outcomes.report(outcomesScopeFor(engine, whoOf(req))));
    // Undo an applied improvement, whoever applied it (the office itself included). Like apply: owners only, as it is on no guest's list in access.ts.
    api.post('/improvements/:id/revert', async (req) => {
      const who = whoOf(req);
      return engine.improver.autopilot.revert(param(req, 'id'), who.id === 'owner' ? 'owner' : `member:${who.name}`);
    });
    // What the office did by itself with what it learned: every `learning.*` event, newest first (the Growth window's "Done by itself").
    api.get('/growth/log', async (req) => {
      const found = (await store.queryEvents({ typePrefix: 'learning.', limit: Math.min(500, Number(query(req).limit) || 200) })).reverse();
      const who = whoOf(req);
      return who.kind === 'owner' ? found : found.map((e) => eventFor(engine, who, e)).filter(Boolean);
    });

    // natural-language commands: plan first, execute only what the owner confirmed
    api.post('/commands/plan', async (req) => engine.commands.planWithFallback(String(body(req).input ?? '')));
    api.post('/commands/execute', async (req) => {
      const input = String(body(req).input ?? '');
      // The plan is recomputed server-side; the client's copy is never trusted.
      const plan = await engine.commands.planWithFallback(input);
      if (plan.problems.length) throw new EngineError(plan.problems.join(' '));
      return engine.commands.execute(plan);
    });
  }, { prefix: '/api' });

  // ───────────── host agent distribution ─────────────
  // The agent is not secret; what protects the office is the enrollment token.
  const agentBundle = [path.join(here, '..', '..', 'host-agent', 'dist', 'orchestrator-agent.mjs'), path.join(here, 'orchestrator-agent.mjs')].find((p) => fs.existsSync(p));
  app.get('/downloads/orchestrator-agent.mjs', async (_req, reply) => {
    if (!agentBundle) return reply.code(404).type('text/plain').send('The agent bundle has not been built on this server. Run: pnpm build');
    return reply.type('text/javascript').send(fs.readFileSync(agentBundle));
  });
  app.get('/install-agent.sh', async (req, reply) => {
    const origin = `${req.protocol}://${req.headers.host}`;
    return reply.type('text/x-shellscript').send(installScript(opts.publicUrl ?? origin));
  });

  // ───────────── static UI ─────────────
  const uiDir = opts.uiDir && fs.existsSync(path.join(opts.uiDir, 'index.html')) ? opts.uiDir : null;
  if (uiDir) {
    await app.register(fastifyStatic, { root: uiDir, prefix: '/', index: ['index.html'] });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/plain').send('Orchestrator server is running. The office UI has not been built yet: run `pnpm build:ui`, or start the dev UI with `pnpm dev:ui`.'));
  }

  await app.listen({ host: opts.host, port: opts.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  const url = `${scheme}://${isLoopbackHost(opts.host) ? '127.0.0.1' : opts.host}:${port}`;
  // When an ephemeral port was requested, workers must be told the real one.
  if (!opts.publicUrl && opts.port === 0) (engine.core as any).publicUrl = url;
  log('info', `Orchestrator server listening on ${url}`);
  sshLinks = new SshLinks(engine, { hubPort: port, tls: !!opts.tls, agentBundle, log });
  sshLinks.start();
  door = new Door({ dataDir: opts.dataDir, hubPort: port, log });
  {
    // The office was open to guests when it last ran: open the door again.
    const wanted = store.kvGet<{ open: boolean; port: number }>('sharing', { open: false, port: 4610 });
    if (wanted.open && !opts.tls) void door.open(wanted.port).catch((e) => log('warn', `the guest door could not be opened: ${(e as Error).message}`));
  }

  return {
    app,
    engine,
    url,
    ownerToken,
    localEnrollToken: () => {
      const { token } = engine.hosts.createEnrollmentToken('local', 10 * 60_000, 'system');
      return token;
    },
    close: async () => {
      sshLinks?.stop();
      knocks.close();
      clearInterval(visits);
      await door?.close();
      engine.stop();
      agents.close();
      clients.close();
      const closed = app.close();
      // Long-polling tool calls and keep-alive sockets must not delay shutdown.
      setTimeout(() => {
        for (const ws of (app as any).websocketServer?.clients ?? []) ws.terminate();
        (app.server as any).closeAllConnections?.();
      }, 300).unref();
      await closed;
      await store.close();
    },
  };
}
