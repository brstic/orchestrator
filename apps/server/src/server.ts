import { Door, inviteCode } from './door.ts';
import { Guests, whoIs, type Who } from './guests.ts';
import { Invites, inviteLink, invitePage } from './invites.ts';
import { PHONE_MESSAGE, isPhone, phonePage } from './phone.ts';
import { Logins, SESSION_DAYS } from './logins.ts';
import { Knocks, type Admission } from './knocks.ts';
import { allowed, closedTo, eventFor, mayCall, mayReadRoutine, memberOf, outcomesScopeFor, stateFor } from './access.ts';
import { Telegram } from './telegram.ts';
import { RentDoor, pageAt } from './rent-door.ts';
import { HiFi, nowPlaying } from './radio.ts';
import { ArcadeShelf } from './arcade.ts';
import { SshLinks } from './ssh-links.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ROLE_CATALOGUE, type Host, stripEnd } from '@orchestrator/contracts';
import { NotFoundError, PgStore, Store, generateToken, type Storage } from '@orchestrator/database';
import { handleMcpPost } from '@orchestrator/integrations';
import { Engine, EngineError, type Timings, SaidFiles } from '@orchestrator/orchestration';
import { AgentHub, ClientHub } from './hubs.ts';


/** What people who walked into a showcase may change through its door: the work of the office (`docs/DEMO.md`). */
export const SHOWCASE_WORK = new Set([
  'POST /employees',
  'PATCH /employees/:id',
  'POST /employees/:id/message',
  'POST /employees/:id/pause',
  'POST /employees/:id/resume',
  'POST /employees/:id/start',
  'POST /employees/:id/stop',
  'POST /employees/:id/report',
  'PUT /employees/:id/goal',
  'DELETE /employees/:id/goal',
  'POST /tasks',
  'PATCH /tasks/:id',
  'POST /tasks/:id/comments',
  'POST /tasks/:id/correct',
  'POST /tasks/:id/review',
  'POST /tasks/:id/send-back',
  'POST /tasks/:id/stop',
  'POST /tasks/:id/unblock',
  'POST /tasks/:id/retry-merge',
  'POST /tasks/release',
  'POST /questions/:id/answer',
  'POST /meetings',
  'POST /meetings/:id/cancel',
  'POST /routines',
  'PATCH /routines/:id',
  'POST /routines/:id/run',
  'DELETE /routines/:id',
  'POST /notifications/read',
  'POST /notifications/:id/resolve',
  'POST /seen',
  'POST /radio/play',
  'POST /radio/stop',
  'POST /projects/:id/pause',
  'POST /projects/:id/resume',
  'POST /projects/:id/plan',
  'POST /commands/plan',
  'POST /memory/recall',
  'POST /logout',
]);
export const SHOWCASE_LIMITS = { employees: 30, openTasks: 80 };

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
  /** The `mempalace` program for the office's long memory. Absent: looked for (see `findMemPalace`); null: none. */
  memoryBin?: string | null;
  /**
   * A showcase office, open to anybody (`docs/DEMO.md`): whoever knocks at the door is let in at once as an owner
   * (twelve hours) who may only do the office's work (`SHOWCASE_WORK`); voices are not passed on. For the public demo
   * office only — its employees must be the stand-in that runs only signed scripts (`ORCH_FAKE_KEY`).
   */
  showcase?: boolean;
  /** Telegram's Bot API for employees' bots (`docs/TELEGRAM.md`); tests point it at a stand-in. Default: Telegram itself. */
  telegramApi?: string;
  /** How long one wait for a bot's messages lasts (s). */
  telegramPollSeconds?: number;
}

/**
 * Where MemPalace is, if it is on this machine: `ORCH_MEMPALACE_BIN`, else the environment the office's own
 * installer makes beside the program (`<install folder>/mempalace-venv`). It is not looked for on PATH: a
 * MemPalace somebody installed for themselves is theirs, with a palace of their own.
 */
function findMemPalace(): string | null {
  const fromEnv = process.env.ORCH_MEMPALACE_BIN;
  if (fromEnv) return fromEnv === 'none' ? null : fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const root of [path.resolve(here, '../../../..'), path.resolve(here, '../../..'), path.resolve(here, '../..')]) {
    const bin = path.join(root, 'mempalace-venv', 'bin', 'mempalace');
    if (fs.existsSync(bin)) return bin;
  }
  return null;
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
/**
 * The office's address as it may stand in a shell script: a plain web address and nothing else. (Where the office was
 * not told its public address, this comes from the request's own Host header.)
 */
export function safeServerUrl(serverUrl: string): string {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(serverUrl) && !/^https?:\/\/\[[0-9A-Fa-f:]+\](:\d{1,5})?$/.test(serverUrl)) throw new EngineError('this office cannot say its own address; start it with --public-url', 400);
  return serverUrl.replace(/\/+$/, '');
}

function installScript(serverUrl: string): string {
  return `#!/bin/sh
# Installs the Orchestrator host agent for the current user (no root needed).
set -eu
SERVER='${safeServerUrl(serverUrl)}'
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
  const clients = new ClientHub(log, { showcase: !!opts.showcase });
  const publicUrl = (opts.publicUrl ?? `${scheme}://${isLoopbackHost(opts.host) ? '127.0.0.1' : opts.host}:${opts.port}`).replace(/\/+$/, '');
  const engine = new Engine({ store, agents, publicUrl, timings: opts.timings, log, vaultKeyFile: path.join(opts.dataDir, 'vault.key'), filesDir: path.join(opts.dataDir, 'files'), memory: { bin: opts.memoryBin === undefined ? findMemPalace() : opts.memoryBin, dir: path.join(opts.dataDir, 'palace') } }, { send: (clientId, msg) => clients.send(clientId, msg) });
  agents.attach(engine);
  clients.attach(engine);
  // The office's hi-fi: what is on is told to every window, and follows the list of stations when an owner edits it.
  // The arcade's shelf: the games the members brought, kept with the office (docs/ARCADE.md).
  const shelf = new ArcadeShelf(path.join(opts.dataDir, 'arcade'), () => clients.arcadeChanged());
  clients.setShelf(shelf);
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
  // ── employees' own Telegram bots (docs/TELEGRAM.md) ──
  /** Who a member is now, by id — or null when they are no longer in (revoked, run out, made a visitor). */
  const personNow = (id: string): Who | null => {
    if (id === 'owner') return { kind: 'owner', id: 'owner', name: engine.core.settings.ownerName || 'the boss', role: 'owner' };
    const g = guests.get(id);
    if (!g || g.revokedAt || (g.expiresAt && Date.parse(g.expiresAt) < Date.now())) return null;
    return g.role === 'owner' ? { kind: 'owner', id: g.id, name: g.name, role: 'owner' } : { kind: 'guest', id: g.id, name: g.name, role: g.role as 'colleague' | 'visitor' };
  };
  const telegram = new Telegram({
    engine,
    store,
    log,
    api: (opts.telegramApi ?? process.env.ORCH_TELEGRAM_API ?? 'https://api.telegram.org').replace(/\/+$/, ''),
    pollSeconds: opts.telegramPollSeconds ?? 50,
    mayWork: (personId, employeeId) => {
      const who = personNow(personId);
      if (!who) return null;
      const member = memberOf(engine, 'employee', employeeId);
      if (closedTo(engine, who, member) || !allowed(who, 'work', member)) return null;
      return { id: who.id, name: who.name, owner: who.kind === 'owner' };
    },
  });
  telegram.start();
  // Whose machines may connect: a member who is still here, is more than a visitor, and whose time is not up.
  engine.hosts.memberInGoodStanding = (memberId) => {
    const g = guests.get(memberId);
    return !!g && !g.revokedAt && g.role !== 'visitor' && !(g.expiresAt && Date.parse(g.expiresAt) <= Date.now());
  };
  const logins = new Logins(engine, guests);
  // A sign-in that has ended (signed out, the password changed) is over for the windows that are open with it, too.
  logins.onEnded = (guestId, token) => clients.dropLogins(guestId, token ? Logins.keyOf(token) : undefined);
  const invites = new Invites(store);
  // ── the Rent portal: clients who talk to the employees they rent, at the office's address (docs/RENT.md) ──
  // (`rentDoor` is made once `addressOf` exists, below.)
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
  /**
   * The path under /api that the access rules judge — as the router reads it: with percent-encodings resolved, piece
   * by piece. (Judged as it was typed, `/employees/x/doc%73` matched no rule while the router served `/docs`.)
   * A piece that hides a slash is nobody's legitimate request: it matches no rule, so only what needs no rule passes.
   */
  const routeOf = (req: FastifyRequest): string => {
    const raw = (req.url.split('?')[0] ?? '').replace(/^\/api/, '');
    if (!raw.includes('%')) return raw;
    try {
      const parts = raw.split('/').map((p) => decodeURIComponent(p));
      return parts.some((p) => p.includes('/')) ? '/\u0000not-a-route' : parts.join('/');
    } catch {
      return '/\u0000not-a-route';
    }
  };
  /** Where a request comes from: what the door says (it sets the header itself), otherwise the connection's own address. */
  const addressOf = (req: FastifyRequest): string => (viaDoor(req) ? String(req.headers['x-forwarded-for'] ?? req.ip) : req.ip);
  const rentDoor = new RentDoor({ engine, guests, address: () => store.kvGet<{ address: string | null }>('sharing', { address: null }).address, addressOf, page: pageAt(opts.uiDir ?? null), log });
  rentDoor.register(app);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof EngineError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err?.validation || err?.statusCode === 400) return reply.code(400).send({ error: err.message });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    log('error', `request failed: ${err?.stack ?? err}`);
    return reply.code(500).send({ error: 'internal error' });
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    // Nothing of the office is shown in a frame, with one exception: the arcade's console, a page the office's own
    // page frames (docs/ARCADE.md, "The frame"). No other site may frame that one either.
    reply.header('x-frame-options', req.url.split('?')[0] === '/assets/arcade.html' ? 'SAMEORIGIN' : 'DENY');
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
  /** What a member's app keeps: where the office is, which certificate is its own, and the member's credential. */
  const connectionOf = (guest: { name: string; role: string }, token: string): string => {
    const st = door!.status();
    const extra = store.kvGet<{ address: string | null }>('sharing', { address: null }).address;
    return inviteCode({ office: engine.core.settings.companyName, guest: guest.name, role: guest.role, token, addresses: [...new Set([...(extra ? [extra] : []), ...st.addresses])], fingerprint: st.fingerprint ?? '' });
  };
  /** Knocking exists only where the office is open to people from outside: through its door. */
  const atDoor = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (viaDoor(req)) return true;
    void reply.code(404).send({ error: 'not found' });
    return false;
  };
  const knockSecret = (req: FastifyRequest): unknown => req.headers['x-knock-secret'];
  app.get('/knock', async (req, reply) => {
    if (!atDoor(req, reply)) return reply;
    return { orchestrator: true, office: engine.core.settings.companyName, ...(opts.showcase ? { showcase: true } : {}) };
  });
  app.post('/knock', { bodyLimit: 2048 }, async (req, reply) => {
    if (!atDoor(req, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const k = knocks.knock({ name: b.name, via: b.via, ip: String(req.headers['x-forwarded-for'] ?? req.ip) });
    // A showcase lets everybody in at once, for as long as a browser visit — as an owner, to try everything; what would
    // spoil the demo for the others is refused below (`SHOWCASE_WORK`), and its employees run nobody's words.
    if (opts.showcase) {
      knocks.admit(k.id, (knock): Admission => {
        const expiresAt = new Date(Date.now() + BROWSER_VISIT_MS).toISOString();
        const { guest, token } = guests.invite({ name: guests.freeName(knock.name), role: 'owner', via: knock.via === 'browser' ? 'knock-browser' : 'knock-app', expiresAt }, 'showcase');
        return { role: 'owner', name: guest.name, token, invite: connectionOf(guest, token), expiresAt, memberId: guest.id };
      });
    }
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

  // Signing in with a name and a password: a member's second way in. What comes back is a session of that member
  // (their role, thirty days) — never the office's own owner token. Wrong attempts are counted per name and per address.
  app.post('/login', { bodyLimit: 2048 }, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const b = (req.body ?? {}) as Record<string, unknown>;
    // The name of a client of the Rent portal: their session, for the portal (they never come into the office).
    if (rentDoor.isClient(b.username)) return rentDoor.signIn(b.username, b.password, addressOf(req));
    const { guest, token, expiresAt } = await logins.signIn(b.username, b.password, addressOf(req));
    return { token, name: guest.name, role: guest.role, office: engine.core.settings.companyName, expiresAt, days: SESSION_DAYS };
  });

  // An invitation link. In a browser it is a page that says what to do with it; the app exchanges its code, once,
  // for what it keeps: the office's addresses, the certificate to trust and the member's own credential.
  app.get('/join/:code', async (req, reply) => {
    if (!atDoor(req, reply)) return reply;
    return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(invitePage(engine.core.settings.companyName));
  });
  app.post('/join', { bodyLimit: 2048 }, async (req, reply) => {
    if (!atDoor(req, reply)) return reply;
    void reply.header('cache-control', 'no-store');
    const code = String(((req.body ?? {}) as Record<string, unknown>).code ?? '').split('.')[0];
    const { guest, token } = guests.issue(invites.redeem(code, String(req.headers['x-forwarded-for'] ?? req.ip)));
    return { office: engine.core.settings.companyName, name: guest.name, role: guest.role, invite: connectionOf(guest, token) };
  });


  // ───────────── a showcase: what people who walked in may change ─────────────
  // They come in as owners, to try everything; through the door they may only do the work of the office — talk, tasks,
  // answers, meetings, goals, routines, the hi-fi, hiring (up to SHOWCASE_LIMITS) — and nothing that runs the office
  // (settings, access, machines, accounts, the vault, the floor plan) or takes anything away (`docs/DEMO.md`).
  if (opts.showcase) {
    app.addHook('onRequest', async (req, reply) => {
      if (!viaDoor(req) || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
      const route = req.routeOptions?.url ?? '';
      if (!route.startsWith('/api/')) return;
      const key = `${req.method} ${route.slice(4)}`;
      if (!SHOWCASE_WORK.has(key)) return reply.code(403).send({ error: 'Not in the demo office: this would change it for everybody else. In your own office you can.' });
      const st = engine.state();
      if (key === 'POST /employees' && st.employees.filter((e) => !e.archived).length >= SHOWCASE_LIMITS.employees) return reply.code(429).send({ error: `The demo office is full (${SHOWCASE_LIMITS.employees} people). Talk to the ones who are here.` });
      if (key === 'POST /tasks' && st.tasks.filter((t) => t.status !== 'DONE').length >= SHOWCASE_LIMITS.openTasks) return reply.code(429).send({ error: 'The board is full right now. Wait for the team to finish some work.' });
    });
  }

  // ───────────── a phone is told that the office is for a computer ─────────────
  // Before anything else is looked at: the page, an invitation link (which is then not used up), the door, the API.
  // Machines are not people: host agents, employees' sessions (`/mcp`) and health checks are let through.
  app.addHook('onRequest', async (req, reply) => {
    if (!isPhone(req.headers['user-agent'])) return;
    const route = (req.raw.url ?? '/').split('?')[0]!;
    if (route === '/healthz' || route === '/mcp' || route === '/ws/agent') return;
    // The Rent portal is made for a phone as much as for a computer: its page, its files and its API.
    if (route === '/rent' || route.startsWith('/rent/') || route.startsWith('/r/') || route.startsWith('/assets/') || route.startsWith('/favicon')) return;
    const wantsPage = req.method === 'GET' && !route.startsWith('/api/') && !route.startsWith('/ws/') && !/\.[a-z0-9]{2,5}$/i.test(route);
    void reply.header('cache-control', 'no-store');
    if (wantsPage) return reply.code(403).type('text/html; charset=utf-8').send(phonePage(engine.core.settings.companyName));
    return reply.code(403).send({ error: PHONE_MESSAGE, phone: true });
  });

  // ───────────── WebSockets ─────────────
  app.get('/ws/agent', { websocket: true }, (socket, req) => agents.handle(socket as any, isLoopbackAddress(req.socket.remoteAddress), viaDoor(req)));
  app.get('/ws/client', { websocket: true }, (socket, req) => {
    // (The hook above answers a phone before the connection is made; this is for a socket that got here anyway.)
    if (isPhone(req.headers['user-agent'])) {
      (socket as any).close(4008, 'desktop only');
      return;
    }
    const who = identify(req);
    if (!who) {
      (socket as any).close(4003, 'unauthorized');
      return;
    }
    const token = tokenOf(req);
    const session = token && logins.isSession(token) ? store.checkCredential('guest', token) : null;
    clients.handle(socket as any, who, session ? Logins.keyOf(token!) : null, session?.expiresAt ?? null);
  });

  // ───────────── MCP (authenticated per worker session) ─────────────
  app.post('/mcp', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const session = engine.sessions.sessionByMcpToken(tokenOf(req));
    const employee = session ? engine.core.employees.get(session.employeeId) : undefined;
    if (!session || !employee) return reply.code(401).header('www-authenticate', 'Bearer').send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: invalid or expired Orchestrator session token' } });
    // A tool call can be held open for minutes (ask_boss, a wait for a colleague): if the caller hangs up first, say so.
    const gone = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) gone.abort();
    });
    const res = await handleMcpPost(req.body, engine.mcp, { session, employee, signal: gone.signal });
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
        if (who.id === 'owner') {
          // The office's own computer does everything — except reach into a room its member has closed.
          if (routeOf(req).startsWith('/\u0000')) return reply.code(400).send({ error: 'that is not a path of this office' });
          const closed = mayCall(engine, who, req.method, routeOf(req), req.body as Record<string, unknown> | null);
          if (!closed.ok) return reply.code(403).send({ error: closed.reason });
          return;
        }
        // A member: what their role allows, on what is shared or theirs. What they change is on the record under their name.
        const route = routeOf(req);
        if (route.startsWith('/\u0000')) return reply.code(400).send({ error: 'that is not a path of this office' });
        const verdict = mayCall(engine, who, req.method, route, req.body as Record<string, unknown> | null);
        if (!verdict.ok) return reply.code(403).send({ error: verdict.reason });
        if (req.method !== 'GET') engine.core.audit(`member:${who.name}`, 'member.action', route, { method: req.method, role: who.role });
        return;
      }
      // (Through the door the office's own token is never taken, and anybody on the network can send a wrong
      // credential: that is not an attempt on the owner token, and nobody outside gets to raise this alarm.)
      if (req.headers.authorization && !viaDoor(req)) {
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
    api.get('/usage', async (req) => engine.sessions.accountUsage().map((a) => (allowed(whoOf(req), 'work', engine.hosts.memberOfHost(a.hostId)) && !closedTo(engine, whoOf(req), engine.hosts.memberOfHost(a.hostId)) ? a : { ...a, email: null, organization: null })));
    // The foreman: who it is, the round in flight and the last ones, and what needs attention right now (owner only).
    api.get('/foreman', async () => engine.foreman.status());
    // `hasPassword`: may this member sign in with a name and password; `passwordSession`: is this very session such a sign-in.
    api.get('/me', async (req) => ({ kind: whoOf(req).kind, role: whoOf(req).role, name: whoOf(req).name, id: whoOf(req).id, office: engine.core.settings.companyName, hasPassword: logins.has(whoOf(req).id), passwordSession: logins.isSession(tokenOf(req)) }));
    api.get('/people', async () => clients.people());
    // A member's own computer: a one-time enrollment for the host agent their desktop app runs while they are here.
    api.post('/me/host', async (req) => {
      const who = whoOf(req);
      if (who.id === 'owner') throw new EngineError('This is the office\'s own computer already; its sessions are the shared ones.');
      return { ...engine.hosts.createMemberEnrollment({ id: who.id, name: who.name }), hosts: engine.hosts.ofMember(who.id).map((x) => ({ id: x.id, name: x.name, status: x.status })) };
    });
    // Servers a member brings into the office themselves: their desktop app reaches the server over SSH with the
    // member's own keys, and the agent it starts there enrols with this one-time token and then connects to the
    // office by itself, through the door. The server is the member's until they share it.
    const ownServer = (req: FastifyRequest) => {
      const who = whoOf(req);
      const host = engine.core.hosts.get(param(req, 'id'));
      if (!host || !host.ownerId || host.status === 'revoked') throw new EngineError('there is no such server', 404);
      // Whose it is decides, not whether it is shared right now: a colleague manages their own, an owner anyone's.
      if (host.ownerId !== who.id && who.kind !== 'owner') throw new EngineError('That server is another member\'s: only they and the owners of this office can share or remove it.', 403);
      return host;
    };
    const serverView = (x: Host) => ({ id: x.id, name: x.name, status: x.status, shared: !x.memberId, ownerId: x.ownerId ?? null, ownerName: x.ownerName ?? null, hostname: x.info?.hostname ?? null, lastSeenAt: x.lastSeenAt });
    api.get('/me/servers', async (req) => engine.hosts.serversOf(whoOf(req).id).map(serverView));
    api.post('/me/servers', async (req) => {
      const who = whoOf(req);
      if (who.id === 'owner') throw new EngineError('On the office\'s own computer servers are linked from Machines: they are the office\'s from the start.');
      return engine.hosts.createMemberServerEnrollment({ id: who.id, name: who.name }, String(body(req).name ?? ''));
    });
    api.patch('/me/servers/:id', async (req) => {
      const host = ownServer(req);
      const b = body(req);
      if (typeof b.name === 'string' && b.name.trim()) engine.hosts.rename(host.id, b.name);
      if (typeof b.shared === 'boolean') engine.hosts.shareMemberServer(host.id, b.shared, actorOf(req));
      return serverView(engine.core.hosts.require(host.id));
    });
    api.delete('/me/servers/:id', async (req) => {
      const host = ownServer(req);
      engine.hosts.revoke(host.id, actorOf(req));
      return { ok: true };
    });
    // How a member wants their own room (size, colour, name, furniture): theirs to decide.
    api.get('/me/room', async (req) => engine.hosts.memberRoom(whoOf(req).id) ?? {});
    api.put('/me/room', async (req) => {
      const who = whoOf(req);
      if (who.id === 'owner') throw new EngineError('The office\'s own computer has no room of its own; rooms belong to members who connect.');
      return engine.hosts.setMemberRoom(who.id, body(req), `member:${who.name}`);
    });
    /** Someone who may no longer have a computer in the office (revoked, or now a visitor): theirs are disconnected for good. */
    // Everything the member brought in: their own computers and the servers they linked, shared or not.
    const dropHostsOf = (memberId: string) => {
      for (const x of engine.hosts.broughtBy(memberId)) engine.hosts.revoke(x.id, 'system');
    };

    // ── guests and the door they come in through (owner only: not in any guest's allowed routes) ──
    // `inviteExpiresAt`: until when the member's invitation link can still be used (null: it was used, or there is none).
    const sharing = () => ({ door: door?.status() ?? { open: false, port: null, addresses: [], fingerprint: null, error: 'the server is still starting' }, wanted: store.kvGet<{ open: boolean; port: number; address: string | null }>('sharing', { open: false, port: 4610, address: null }), guests: guests.list().map((g) => ({ ...g, hasPassword: logins.has(g.id) })).map((g) => ({ ...g, inviteExpiresAt: g.revokedAt ? null : invites.expiresAtOf(g.id) })), present: clients.people() });
    const invitation = connectionOf;
    /** The address people come to, as the owner set it; with it an invitation is a short link. */
    const officeAddress = () => store.kvGet<{ address: string | null }>('sharing', { address: null }).address;
    /**
     * What the owner sends someone: a link that works once (`link: true`) — or, in an office that has no address
     * set, the whole connection as text to paste.
     */
    const invite = (guest: { id: string; name: string; role: string }, token: string) => {
      const address = officeAddress();
      if (!address) return { invite: invitation(guest, token), link: false, expiresAt: null };
      const { code, expiresAt } = invites.create(guest.id);
      return { invite: inviteLink(address, code, door!.status().fingerprint), link: true, expiresAt };
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
        address = stripEnd(String(b.address ?? '').trim(), '/') || null;
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
      if (rentDoor.isClient(body(req).name)) throw new EngineError('a client of the Rent portal has that name: everybody who signs in at the door needs a name of their own');
      // With a link, the credential is made when the link is used; without, it is in the text itself.
      const { guest, token } = guests.invite({ name: String(body(req).name ?? ''), role: body(req).role, credential: !officeAddress() });
      return { guest, ...invite(guest, token) };
    });
    api.post('/guests/:id/reissue', async (req) => {
      needDoor();
      const { guest, token } = guests.reissue(param(req, 'id'), 'owner', { credential: !officeAddress() });
      // A new invitation is how an owner takes back what a member came in with — all of it. A password is one of
      // those ways in (and whoever held the member's credential could have set one), so it goes too.
      logins.clear(guest.id, actorOf(req));
      invites.drop(guest.id);
      clients.dropGuest(guest.id);
      return { guest, ...invite(guest, token) };
    });
    api.patch('/guests/:id', async (req) => {
      const guest = guests.update(param(req, 'id'), { role: body(req).role });
      clients.dropGuest(guest.id); // they come back in with the new role
      if (guest.role === 'visitor') dropHostsOf(guest.id);
      return guest;
    });
    // A member's password for signing in at the door (owners; no rule in access.ts). The password itself is never read back.
    api.post('/guests/:id/password', async (req) => {
      logins.set(param(req, 'id'), body(req).password, actorOf(req));
      return { ok: true, hasPassword: true };
    });
    api.delete('/guests/:id/password', async (req) => {
      logins.clear(param(req, 'id'), actorOf(req));
      return { ok: true, hasPassword: false };
    });
    // One's own: change it (knowing the current one), and end the session one is signed in with.
    api.post('/me/password', async (req) => {
      const who = whoOf(req);
      if (who.id === 'owner') throw new EngineError('The office\'s own computer needs no password; give a member one in Access.');
      const b = body(req);
      const guest = guests.get(who.id);
      if (!guest) throw new EngineError('unknown member', 404);
      // Proved again with the current password (through the same counting as at the door), unless none was set yet.
      if (logins.has(who.id)) await logins.check(guest.name, b.current, addressOf(req));
      logins.set(who.id, b.password, `member:${guest.name}`);
      return { ok: true };
    });
    api.post('/logout', async (req) => ({ ok: logins.signOut(tokenOf(req)) }));
    api.delete('/guests/:id', async (req) => {
      const guest = guests.revoke(param(req, 'id'));
      logins.clear(guest.id, actorOf(req));
      invites.drop(guest.id);
      clients.dropGuest(guest.id);
      dropHostsOf(guest.id);
      return guest;
    });
    // ── the vault: the office's credentials. The list never carries a value; a value comes out only for an owner (reveal). ──
    const vaultActor = (req: FastifyRequest) => {
      const who = whoOf(req);
      return who.id === 'owner' ? { kind: 'owner' as const, id: null, name: who.name } : { kind: 'member' as const, id: who.id, name: who.name };
    };
    api.get('/vault', async (req) => ({ entries: engine.vault.list(String(query(req).q ?? '')) }));
    api.post('/vault', async (req) => {
      const b = body(req);
      return engine.vault.put({ name: String(b.name ?? ''), value: String(b.value ?? ''), kind: b.kind, service: String(b.service ?? ''), username: String(b.username ?? ''), description: String(b.description ?? '') }, vaultActor(req), 'added');
    });
    api.patch('/vault/:id', async (req) => engine.vault.update(param(req, 'id'), body(req), vaultActor(req)));
    api.delete('/vault/:id', async (req) => engine.vault.remove(param(req, 'id'), vaultActor(req)));
    api.post('/vault/:id/reveal', async (req, reply) => {
      void reply.header('cache-control', 'no-store');
      const { entry, value } = engine.vault.use(param(req, 'id'), vaultActor(req), 'revealed');
      return { name: entry.name, value };
    });
    // ── the long memory: whether there is one, and asking it (as an employee would) ──
    api.get('/memory', async () => engine.memory.status());
    // Owners only (no rule in access.ts): throw the memory away and write the office's record into it again.
    api.post('/memory/rebuild', async () => engine.memory.rebuild());
    api.post('/memory/recall', async (req) => ({ hits: await engine.memory.recall(String(body(req).query ?? ''), { results: 8, timeoutMs: 45_000 }) }));
    api.get('/roles', async () => ROLE_CATALOGUE);
    api.get('/audit', async (req) => store.recentAudit(Number(query(req).limit) || 200));
    api.get('/events', async (req) => {
      const q = query(req);
      const found = await store.queryEvents({ employeeId: q.employeeId, taskId: q.taskId, sessionId: q.sessionId, projectId: q.projectId, since: q.since, beforeSeq: q.before ? Number(q.before) : undefined, limit: q.limit ? Number(q.limit) : 200, excludeTypes: q.includeActivity ? undefined : ['session.activity', 'terminal.output'] });
      // What happened on a member's own computer is theirs and the owners' to read.
      const who = whoOf(req);
      return found.map((e) => eventFor(engine, who, e)).filter(Boolean);
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
      // With the door open the office is reached from outside, and then it asks outside addresses only (`radio.ts`).
      return { text: station?.nowPlayingUrl ? await nowPlaying(station.nowPlayingUrl, { insideToo: door?.status().open !== true }) : null };
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
          ...(changed.includes('autoAsksHighRisk') ? { autoAsksHighRisk: after.autoAsksHighRisk } : {}),
          ...(changed.includes('unrestrictedAsksHighRisk') ? { unrestrictedAsksHighRisk: after.unrestrictedAsksHighRisk } : {}),
        });
      }
      if (changed.includes('autoAsksHighRisk') || changed.includes('unrestrictedAsksHighRisk')) engine.sessions.highRiskSwitched();
      return after;
    });
    api.put('/layout', async (req) => engine.updateLayout(body(req) as any));
    api.get('/layout/capacity', async () => ({ desks: engine.core.layout.desks.length, freePodSlots: engine.freePodSlots() }));
    api.post('/layout/pods', async () => engine.addDeskPod());
    api.delete('/layout/desks/:id', async (req) => engine.removeDesk(param(req, 'id')));
    // Several empty desks at once: a whole table.
    api.post('/layout/desks/remove', async (req) => engine.removeDesks(Array.isArray(body(req).ids) ? body(req).ids.map(String) : []));
    api.post('/layout/pods/:id/desks', async (req) => engine.addSeat(param(req, 'id')));
    api.put('/layout/pods/:id/label', async (req) => engine.setPodLabel(param(req, 'id'), String(body(req).label ?? '')));

    // employees
    api.post('/employees', async (req) => engine.hire(body(req) as any));
    api.patch('/employees/:id', async (req) => engine.updateEmployee(param(req, 'id'), body(req), actorOf(req)));
    // For good, with what is theirs (see Engine.deleteEmployee). `?tasks=delete` takes their tasks too; otherwise they go back on the board.
    api.delete('/employees/:id', async (req) => engine.deleteEmployee(param(req, 'id'), { tasks: query(req).tasks === 'delete' ? 'delete' : 'keep' }, actorOf(req)));
    // A member takes a shared employee among their own, or gives them back. Listing only: who may use them does not change.
    api.post('/employees/:id/keep', async (req) => {
      const who = whoOf(req);
      if (who.id === 'owner') throw new EngineError("At the office's own computer everything shared is yours to see already; taking someone among one's own is for members.");
      return engine.employees.keep(param(req, 'id'), { id: who.id, name: who.name }, actorOf(req), who.kind === 'owner');
    });
    api.post('/employees/:id/give-back', async (req) => {
      const who = whoOf(req);
      const kept = engine.core.employees.require(param(req, 'id')).keptBy;
      if (kept && kept.id !== who.id && who.kind !== 'owner') throw new EngineError(`${kept.name} looks after them: they give them back themselves, or an owner of the office does.`, 403);
      return engine.employees.keep(param(req, 'id'), null, actorOf(req));
    });
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
      const b = body(req);
      const ids: string[] = Array.isArray(b.fileIds) ? b.fileIds.map(String) : [];
      // A picture can be the whole message.
      const text = String(b.body ?? '').trim() || (ids.length ? 'Look at this.' : '');
      if (!text) throw new EngineError('message is empty');
      // From a colleague, the employee is told who is speaking: it is not the boss.
      const who = whoOf(req);
      // Files that go with it (a pasted screenshot, a document) are on the employee's machine before the words are.
      const sent = await engine.saidFiles.deliver(engine.core.employees.require(param(req, 'id')), ids, who.id);
      return engine.comms.sendMessage({ from: { kind: 'owner', id: null, name: who.kind === 'owner' ? (who.id === 'owner' ? 'the boss' : `${who.name} (an owner of this office)`) : `${who.name} (a colleague the boss invited; not the boss)` }, toEmployeeId: param(req, 'id'), body: text + SaidFiles.note(sent.lines), files: sent.files, said: text });
    });
    // A goal: they keep working toward it until it holds (`Goals`). From a colleague, the goal says who gave it.
    api.put('/employees/:id/goal', async (req) => {
      const who = whoOf(req);
      return engine.goals.set(param(req, 'id'), { condition: body(req).condition, check: body(req).check }, { kind: 'owner', id: who.id, name: who.kind === 'owner' ? (who.id === 'owner' ? 'the boss' : who.name) : `${who.name} (a colleague)` });
    });
    api.delete('/employees/:id/goal', async (req) => {
      const who = whoOf(req);
      return { goal: engine.goals.clear(param(req, 'id'), { kind: 'owner', id: who.id, name: who.kind === 'owner' ? (who.id === 'owner' ? 'the boss' : who.name) : `${who.name} (a colleague)` }) };
    });
    // Files for a message to an employee: begun, sent in pieces, then named in the message (`fileIds`). Only the one who began a file adds to it and sends it.
    api.post('/employees/:id/files', async (req) => engine.saidFiles.begin(param(req, 'id'), { name: String(body(req).name ?? ''), size: Number(body(req).size) }, whoOf(req).id));
    api.post('/employees/:id/files/:fid/data', async (req) => engine.saidFiles.append(param(req, 'id'), param(req, 'fid'), Number(body(req).offset) || 0, Buffer.from(String(body(req).dataBase64 ?? ''), 'base64'), whoOf(req).id));
    api.get('/employees/:id/files/:fid', async (req, reply) => {
      const { file, path: where } = engine.saidFiles.open(param(req, 'id'), param(req, 'fid'));
      // As for a task's files: only the picture formats a browser shows safely are sent as what they are.
      const inline = /^image\/(png|jpeg|gif|webp)$/.test(file.mime);
      reply
        .header('content-type', inline ? file.mime : 'application/octet-stream')
        .header('content-length', String(fs.statSync(where).size))
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, max-age=3600');
      return reply.send(fs.createReadStream(where));
    });
    // Routines: a standing instruction the office repeats for one employee (see `routines.ts`).
    const actorOf = (req: FastifyRequest) => (whoOf(req).id === 'owner' ? 'owner' : `member:${whoOf(req).name}`);
    // The Rent portal, the owner's side: clients, what they rent, what each rented employee may do (rent-door.ts).
    rentDoor.ownerRoutes(api, actorOf, (req) => whoOf(req).id);
    /** The person behind a request, as the task conversation names them. */
    const personOf = (req: FastifyRequest): { kind: 'owner' | 'member'; id: string | null; name: string } => (whoOf(req).id === 'owner' ? { kind: 'owner', id: null, name: 'The boss' } : { kind: 'member', id: whoOf(req).id, name: whoOf(req).name });
    api.get('/routines', async (req) => engine.routines.list().filter((r) => mayReadRoutine(engine, whoOf(req), r)));
    api.post('/routines', async (req) => engine.routines.create(body(req), actorOf(req)));
    api.patch('/routines/:id', async (req) => engine.routines.update(param(req, 'id'), body(req), actorOf(req)));
    api.delete('/routines/:id', async (req) => {
      engine.routines.remove(param(req, 'id'), actorOf(req));
      return { ok: true };
    });
    api.post('/routines/:id/run', async (req) => engine.routines.runNow(param(req, 'id'), actorOf(req)));
    // The employee's own Telegram bot (docs/TELEGRAM.md). Whoever may work with them may set it up; the token never comes back.
    const telegramBy = (req: FastifyRequest) => ({ id: whoOf(req).id, name: whoOf(req).name, owner: whoOf(req).kind === 'owner' });
    api.get('/employees/:id/telegram', async (req) => telegram.view(engine.core.employees.require(param(req, 'id')).id));
    api.put('/employees/:id/telegram', async (req) => {
      const id = engine.core.employees.require(param(req, 'id')).id;
      const view = await telegram.connect(id, String(body(req).token ?? ''), telegramBy(req));
      return { ...view, ...telegram.pair(id, telegramBy(req)) };
    });
    api.patch('/employees/:id/telegram', async (req) => telegram.settings(param(req, 'id'), body(req)));
    api.delete('/employees/:id/telegram', async (req) => telegram.disconnect(param(req, 'id'), telegramBy(req)));
    api.post('/employees/:id/telegram/pair', async (req) => telegram.pair(param(req, 'id'), telegramBy(req)));
    api.post('/employees/:id/telegram/check', async (req) => telegram.refresh(param(req, 'id')));
    api.delete('/employees/:id/telegram/people/:tg', async (req) => telegram.unpair(param(req, 'id'), Number((req.params as Record<string, string>).tg), telegramBy(req)));
    api.patch('/employees/:id/telegram/groups/:chat', async (req) => telegram.group(param(req, 'id'), Number((req.params as Record<string, string>).chat), body(req)));
    api.delete('/employees/:id/telegram/groups/:chat', async (req) => telegram.leaveGroup(param(req, 'id'), Number((req.params as Record<string, string>).chat), telegramBy(req)));
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
    // A new folder on a machine, for somebody about to be hired into it: one level, inside what that machine allows.
    api.post('/hosts/:id/folders', async (req) => {
      const b = body(req);
      const made = await engine.core.agents.rpc<{ path: string; name: string }>(param(req, 'id'), { method: 'fs.mkdir', params: { parent: String(b.parent ?? ''), name: String(b.name ?? '') } }).catch((e) => {
        // (A machine whose agent is older than this does not know how.)
        throw new EngineError(/unknown|unsupported|not implemented/i.test((e as Error).message) ? 'This machine runs an older agent that cannot make folders yet. Update its app (or agent), or make the folder there by hand.' : (e as Error).message);
      });
      engine.core.audit(actorOf(req), 'folder.created', param(req, 'id'), { path: made.path });
      return made;
    });
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
    // More Claude accounts on a machine (owners: no rule in access.ts). Adding makes the folder there and says how to log in.
    api.post('/hosts/:id/accounts', async (req) => engine.sessions.addAccount(param(req, 'id'), String(body(req).dir ?? ''), actorOf(req)));
    // Signing in to an account from the office, and an account of another service (Z.AI). Owners only, like the rest.
    // What is typed (a sign-in code, an API key) is passed on to that machine and is not written anywhere here.
    api.post('/hosts/:id/accounts/login', async (req) => engine.sessions.accountLogin(param(req, 'id'), { op: 'start', dir: body(req).dir ? String(body(req).dir) : null, fresh: body(req).fresh === true, email: body(req).email ? String(body(req).email) : undefined }, actorOf(req)));
    api.get('/hosts/:id/accounts/login', async (req) => engine.sessions.accountLogin(param(req, 'id'), { op: 'screen', dir: query(req).dir ? String(query(req).dir) : null }, actorOf(req)));
    api.post('/hosts/:id/accounts/login/input', async (req) => engine.sessions.accountLogin(param(req, 'id'), { op: 'input', dir: body(req).dir ? String(body(req).dir) : null, text: body(req).text === undefined ? undefined : String(body(req).text), key: body(req).key ? String(body(req).key) : undefined }, actorOf(req)));
    api.delete('/hosts/:id/accounts/login', async (req) => engine.sessions.accountLogin(param(req, 'id'), { op: 'stop', dir: query(req).dir ? String(query(req).dir) : null }, actorOf(req)));
    api.post('/hosts/:id/accounts/provider', async (req) => {
      const b = body(req);
      const models = b.models && typeof b.models === 'object' ? { opus: String(b.models.opus ?? ''), sonnet: String(b.models.sonnet ?? ''), haiku: String(b.models.haiku ?? '') } : undefined;
      return engine.sessions.addProviderAccount(param(req, 'id'), { dir: b.dir ? String(b.dir) : null, provider: b.provider === 'custom' ? 'custom' : 'zai', token: String(b.token ?? ''), baseUrl: b.baseUrl ? String(b.baseUrl) : undefined, models }, actorOf(req));
    });
    api.post('/hosts/:id/accounts/check', async (req) => ({ accounts: await engine.sessions.checkAccounts(param(req, 'id'), [null, ...(engine.core.hosts.require(param(req, 'id')).claudeAccounts ?? [])]) }));
    api.post('/hosts/:id/accounts/move', async (req) => ({ moved: await engine.sessions.failover({ key: `${param(req, 'id')}|${String(body(req).from ?? '') || 'default'}`, actor: actorOf(req) }) }));
    api.delete('/hosts/:id/accounts', async (req) => {
      engine.sessions.removeAccount(param(req, 'id'), String(query(req).dir ?? ''), actorOf(req));
      return { ok: true };
    });
    api.delete('/hosts/:id', async (req) => {
      engine.hosts.remove(param(req, 'id'));
      return { ok: true };
    });

    // projects & tasks
    api.post('/projects', async (req) => engine.tasks.createProject(body(req) as any));
    api.patch('/projects/:id', async (req) => engine.tasks.updateProject(param(req, 'id'), body(req)));
    // Owners only (no rule in access.ts): the project, its tasks and what was learned for it go; nothing on disk does.
    api.delete('/projects/:id', async (req) => engine.deleteProject(param(req, 'id'), actorOf(req)));
    api.post('/projects/:id/pause', async (req) => ({ interrupted: await engine.pauseProject(param(req, 'id')) }));
    api.post('/projects/:id/resume', async (req) => engine.tasks.updateProject(param(req, 'id'), { status: 'active' }));
    api.post('/projects/:id/plan', async (req) => engine.tasks.planProject(param(req, 'id'), String(body(req).objective ?? ''), String(body(req).plannerId)));
    // Who made it is written down (`owner`, or `member:<name>`), so a member finds the tasks they made.
    api.post('/tasks', async (req) => engine.tasks.createTask(body(req) as any, actorOf(req)));
    api.post('/tasks/release', async (req) => engine.tasks.release(body(req).ids ?? []));
    api.patch('/tasks/:id', async (req) => engine.tasks.updateTask(param(req, 'id'), body(req)));
    api.delete('/tasks/:id', async (req) => {
      engine.tasks.deleteTask(param(req, 'id'));
      return { ok: true };
    });
    // Stepping into a task somebody is working on: stop it (on hold, or removed), or correct it (they are told at once).
    api.post('/tasks/:id/stop', async (req) => engine.tasks.stopTask(param(req, 'id'), { then: body(req).then === 'delete' ? 'delete' : 'hold', note: body(req).note ?? null }, actorOf(req)));
    api.post('/tasks/:id/correct', async (req) => {
      const b = body(req);
      return engine.tasks.correctTask(param(req, 'id'), { note: b.note ?? null, title: typeof b.title === 'string' ? b.title : undefined, description: typeof b.description === 'string' ? b.description : undefined, acceptance: typeof b.acceptance === 'string' ? b.acceptance : undefined, now: b.now === true }, actorOf(req));
    });
    // ── files on a task: what people attach for the employee, and the evidence employees leave ──
    // A file comes in pieces (a first call says what it is; each next one carries up to 512 KB), so that it passes any proxy in front of the office.
    api.post('/tasks/:id/attachments', async (req) => {
      const b = body(req);
      const who = whoOf(req);
      return engine.attachments.begin(param(req, 'id'), { name: String(b.name ?? ''), size: Number(b.size), caption: b.caption ? String(b.caption) : null }, { kind: who.kind === 'owner' ? 'owner' : 'member', id: who.id === 'owner' ? null : who.id, name: who.id === 'owner' ? 'the boss' : who.name });
    });
    api.post('/tasks/:id/attachments/:aid/data', async (req) => {
      const b = body(req);
      return engine.attachments.append(param(req, 'id'), param(req, 'aid'), Number(b.offset) || 0, Buffer.from(String(b.dataBase64 ?? ''), 'base64'));
    });
    api.get('/tasks/:id/attachments/:aid', async (req, reply) => {
      const { attachment, file } = engine.attachments.open(param(req, 'id'), param(req, 'aid'));
      // Only the picture formats a browser shows safely are sent as what they are; everything else is a download.
      const inline = /^image\/(png|jpeg|gif|webp)$/.test(attachment.mime);
      reply
        .header('content-type', inline ? attachment.mime : 'application/octet-stream')
        .header('content-length', String(fs.statSync(file).size))
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, max-age=3600');
      return reply.send(fs.createReadStream(file));
    });
    // ── the arcade's shelf: cartridge files the members bring, kept with the office so every computer has them ──
    // (A cartridge comes in pieces, as a file on a task does. Who is at which table goes over the websocket: `hubs.ts`.)
    api.get('/arcade/games', async () => ({ games: shelf.list() }));
    api.post('/arcade/games', async (req) => shelf.begin(body(req), whoOf(req).name));
    api.post('/arcade/games/:id/data', async (req) => {
      const b = body(req);
      const r = shelf.append(param(req, 'id'), Number(b.offset) || 0, Buffer.from(String(b.dataBase64 ?? ''), 'base64'));
      if (r.done && r.game && !r.already) engine.core.audit(actorOf(req), 'arcade.game_added', r.game.id, { title: r.game.title, file: r.game.file, size: r.game.size });
      return r;
    });
    api.get('/arcade/games/:id/rom', async (req, reply) => {
      const { game, file } = shelf.open(param(req, 'id'));
      reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', String(game.size))
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(game.file)}`)
        .header('x-content-type-options', 'nosniff')
        // The same bytes for ever under this id: a window keeps them.
        .header('cache-control', 'private, max-age=31536000, immutable');
      return reply.send(fs.createReadStream(file));
    });
    api.delete('/arcade/games/:id', async (req) => {
      const game = shelf.remove(param(req, 'id'));
      engine.core.audit(actorOf(req), 'arcade.game_removed', game.id, { title: game.title });
      return { ok: true };
    });
    api.delete('/tasks/:id/attachments/:aid', async (req) => {
      engine.attachments.remove(param(req, 'id'), param(req, 'aid'), actorOf(req));
      return { ok: true };
    });
    api.post('/tasks/:id/review', async (req) => {
      const b = body(req);
      if (b.verdict !== 'approve' && b.verdict !== 'request_changes') throw new EngineError('verdict must be approve or request_changes');
      return engine.tasks.submitReview('owner', param(req, 'id'), b.verdict, String(b.comments ?? ''), personOf(req));
    });
    // The conversation on a task: a person's comment (the answer, when the task waits for one), and sending a task back.
    api.post('/tasks/:id/comments', async (req) => engine.talk.byPerson(param(req, 'id'), String(body(req).body ?? ''), personOf(req), body(req).attachmentIds));
    api.post('/tasks/:id/send-back', async (req) => engine.talk.sendBack(param(req, 'id'), String(body(req).note ?? ''), personOf(req)));
    api.post('/tasks/:id/unblock', async (req) => engine.tasks.unblock(param(req, 'id'), String(body(req).note ?? '')));
    api.post('/tasks/:id/retry-merge', async (req) => engine.tasks.retryMerge(param(req, 'id'), actorOf(req)));
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
      return found.map((e) => eventFor(engine, who, e)).filter(Boolean);
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
    const assets = path.join(uiDir, 'assets') + path.sep;
    await app.register(fastifyStatic, {
      root: uiDir,
      prefix: '/',
      index: ['index.html'],
      // The arcade's console runs in a frame that is no origin at all (docs/ARCADE.md, "The frame"), and a script
      // module is only handed to such a page when the file says anyone may read it. These are the app's own built
      // files, which the door hands to anybody as it is; nothing else gets the header.
      setHeaders: (res, file) => {
        if (file.startsWith(assets)) res.setHeader('access-control-allow-origin', '*');
      },
    });
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
      telegram.close();
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
