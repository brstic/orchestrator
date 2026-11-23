import { ArcadeTables, type ArcadeShelf } from './arcade.ts';
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { eventFor, mayCall, mayDrive, mayReadMessage, mayReadQuestion, mayReadRoutine, maySee, shownTo, stateFor } from './access.ts';
import { VOICE_FRAMES_PER_SECOND, hears, validFrame } from './voice.ts';
import type { AgentRequest, AgentRpc, AgentToServer, ClientToServer, EntityKind, KnockView, Notification, OrchestratorEvent, OutsideAt, PersonPresence, RadioNow, ServerToAgent, ServerToClient } from '@orchestrator/contracts';
import type { Characters } from './characters.ts';
import { hueOf, type Who } from './guests.ts';
import { AUTONOMY_LEVELS, PROTOCOL_VERSION, ROLE_CATALOGUE, apart, cleanOutside, isAutonomyLevel, isEmote, matchRole, notificationFor, nowIso, roleByKey } from '@orchestrator/contracts';
import { EngineError, FOREMAN_ROLE, type AgentLink, type Engine } from '@orchestrator/orchestration';

interface AgentConn {
  ws: WebSocket;
  hostId: string;
  pending: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  lastSeen: number;
  /** The office is disconnecting this machine (it was revoked): nothing it still sends is acted on. */
  dropped?: boolean;
}

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void;

/**
 * Connections from host agents. Hosts dial out to us; we never connect to a
 * host. Each connection is authenticated by its first message.
 */
export class AgentHub implements AgentLink {
  private conns = new Map<string, AgentConn>();
  private engine!: Engine;
  private log: Log;
  private pingTimer: NodeJS.Timeout;

  constructor(log: Log) {
    this.log = log;
    this.pingTimer = setInterval(() => this.heartbeat(), 20000);
    this.pingTimer.unref?.();
  }

  attach(engine: Engine): void {
    this.engine = engine;
  }

  private closing = false;

  close(): void {
    this.closing = true;
    clearInterval(this.pingTimer);
    for (const c of this.conns.values()) {
      try {
        c.ws.close(1001, 'server shutting down');
        // Do not wait on the peer's close handshake: a hung host must not hold up shutdown.
        setTimeout(() => c.ws.terminate(), 200).unref();
      } catch {
        /* ignore */
      }
    }
  }

  private heartbeat(): void {
    const now = Date.now();
    for (const c of this.conns.values()) {
      if (now - c.lastSeen > 70000) {
        this.log('warn', `host ${c.hostId} stopped responding; dropping its connection`);
        c.ws.terminate();
        continue;
      }
      this.sendTo(c, { t: 'ping' });
    }
  }

  private sendTo(c: AgentConn, msg: ServerToAgent): boolean {
    if (c.ws.readyState !== 1) return false;
    try {
      c.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  // ───────────── AgentLink ─────────────

  isOnline(hostId: string): boolean {
    return this.conns.get(hostId)?.ws.readyState === 1;
  }

  rpc<T = any>(hostId: string, rpc: AgentRpc, timeoutMs = 30000): Promise<T> {
    const c = this.conns.get(hostId);
    if (!c || c.ws.readyState !== 1) return Promise.reject(new EngineError('host is offline', 502));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        c.pending.delete(id);
        reject(new EngineError(`host did not answer ${rpc.method} within ${Math.round(timeoutMs / 1000)}s`, 504));
      }, timeoutMs);
      c.pending.set(id, { resolve, reject, timer });
      if (!this.sendTo(c, { t: 'rpc', id, ...rpc } as ServerToAgent)) {
        clearTimeout(timer);
        c.pending.delete(id);
        reject(new Error('host is offline'));
      }
    });
  }

  respondHook(hostId: string, requestId: string, output: Record<string, unknown> | null): boolean {
    const c = this.conns.get(hostId);
    return c ? this.sendTo(c, { t: 'hook.response', requestId, output }) : false;
  }

  disconnect(hostId: string, reason: string): void {
    const c = this.conns.get(hostId);
    if (!c) return;
    this.sendTo(c, { t: 'rejected', reason });
    // Cut the host off now: it is offline for every purpose from this instant,
    // even though the socket takes a moment to close.
    this.conns.delete(hostId);
    for (const p of c.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new EngineError('host disconnected', 502));
    }
    c.pending.clear();
    this.engine.hosts.disconnected(hostId);
    c.dropped = true;
    setTimeout(() => c.ws.close(4003, reason.slice(0, 100)), 50);
    setTimeout(() => c.ws.terminate(), 2000).unref?.();
  }

  // ───────────── sockets ─────────────

  /** `outside`: the connection came in through the door, where only a member's own computer is let in. */
  handle(ws: WebSocket, remoteIsLoopback: boolean, outside = false): void {
    if (this.closing) return void ws.terminate();
    let conn: AgentConn | null = null;
    const helloTimer = setTimeout(() => {
      if (!conn) ws.close(4001, 'no hello');
    }, 10000);

    ws.on('message', (data) => {
      let msg: AgentToServer;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      // (Valid JSON that is not a message — `null`, a number, a list: nothing to read a field of.)
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return void (conn ? undefined : ws.close(4001, 'expected hello'));
      if (!conn) {
        if (msg.t !== 'hello') return ws.close(4001, 'expected hello');
        clearTimeout(helloTimer);
        if (msg.protocol !== PROTOCOL_VERSION) {
          ws.send(JSON.stringify({ t: 'rejected', reason: `protocol mismatch: server speaks v${PROTOCOL_VERSION}, agent v${msg.protocol}` } satisfies ServerToAgent));
          return ws.close(4002, 'protocol');
        }
        const auth = this.engine.hosts.authenticate(msg, remoteIsLoopback && !outside, outside);
        if ('error' in auth) {
          ws.send(JSON.stringify({ t: 'rejected', reason: auth.error } satisfies ServerToAgent));
          this.engine.core.audit('unknown-host', 'host.auth_failed', msg.hostId ?? '-', { reason: auth.error, hostname: msg.info?.hostname });
          const from = String(msg.info?.hostname ?? msg.name ?? 'an unknown machine').slice(0, 80);
          this.engine.comms.securityAlert({
            key: `host-auth:${msg.hostId ?? from}`,
            severity: 'critical',
            title: 'A machine was refused a connection to the office',
            body: `"${from}" tried to connect as a host and was turned away: ${auth.error}. If this was not you, nothing was granted; if it was, enrol the machine again with a new token.`,
            hostId: msg.hostId && this.engine.core.hosts.get(msg.hostId) ? msg.hostId : null,
            data: { hostname: from, loopback: remoteIsLoopback },
          });
          return ws.close(4003, 'unauthorized');
        }
        if (msg.enrollOnly) {
          ws.send(JSON.stringify({ t: 'welcome', hostId: auth.host.id, credential: auth.credential, serverTime: nowIso(), name: auth.host.name } satisfies ServerToAgent));
          return ws.close(1000, 'enrolled');
        }
        const previous = this.conns.get(auth.host.id);
        if (previous) previous.ws.close(4004, 'replaced by a newer connection');
        conn = { ws, hostId: auth.host.id, pending: new Map(), lastSeen: Date.now() };
        this.conns.set(auth.host.id, conn);
        this.engine.hosts.connected(auth.host.id, msg.info);
        this.sendTo(conn, { t: 'welcome', hostId: auth.host.id, credential: auth.credential, serverTime: nowIso(), name: auth.host.name });
        return;
      }
      if (conn.dropped) return;
      conn.lastSeen = Date.now();
      try {
        this.onMessage(conn, msg);
      } catch (e) {
        this.log('error', `agent message ${msg.t}: ${(e as Error).stack}`);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!conn) return;
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new EngineError('host disconnected', 502));
      }
      conn.pending.clear();
      if (this.conns.get(conn.hostId) === conn) {
        this.conns.delete(conn.hostId);
        this.engine.hosts.disconnected(conn.hostId);
        this.engine.comms.hostGone(conn.hostId);
      }
    });
    ws.on('error', () => undefined);
  }

  private onMessage(c: AgentConn, msg: AgentToServer): void {
    const eng = this.engine;
    switch (msg.t) {
      case 'sessions':
        eng.sessions.onSync(c.hostId, msg.sessions);
        break;
      case 'session':
        eng.sessions.onReport(c.hostId, msg.session);
        break;
      case 'session.gone':
        eng.sessions.onHostReportedGone(c.hostId, msg.sessionId, msg.reason, msg.launchId);
        break;
      case 'hook':
        if (eng.hooks.onHook(c.hostId, msg.event)) this.sendTo(c, { t: 'ack', ids: [msg.event.id] });
        break;
      case 'hook.request':
        eng.hooks.markRequest(msg.event);
        eng.hooks.onHookRequest(c.hostId, msg.requestId, msg.event);
        break;
      case 'hook.settled':
        eng.comms.hookSettled(msg.requestId, msg.outcome, msg.detail);
        break;
      case 'term.output':
        if (eng.core.sessions.get(msg.sessionId)?.hostId === c.hostId) {
          eng.core.gateway.onOutput(msg.sessionId, msg.seq, msg.data);
          eng.sessions.noteOutput(msg.sessionId, msg.data.length);
        }
        break;
      case 'term.screen':
        // (What a machine sends is not believed to be a screen: lines that are texts, as many and as long as a screen has.)
        if (eng.core.sessions.get(msg.sessionId)?.hostId === c.hostId && Array.isArray(msg.screen?.lines) && msg.screen.lines.length <= 1000 && msg.screen.lines.every((l: unknown) => typeof l === 'string' && l.length <= 20_000)) {
          eng.core.gateway.onScreen(msg.sessionId, msg.screen);
          eng.sessions.onScreen(msg.sessionId, msg.screen);
        }
        break;
      case 'resources':
        eng.hosts.resources(c.hostId, msg.resources);
        break;
      case 'limits':
        eng.sessions.onLimits(c.hostId, msg);
        break;
      case 'usage':
        eng.sessions.onUsage(c.hostId, msg.sessionId, msg.usage);
        break;
      case 'shells':
        eng.background.onShells(c.hostId, msg.sessionId, msg.shells);
        break;
      case 'rpc.result': {
        const p = c.pending.get(msg.id);
        if (!p) break;
        clearTimeout(p.timer);
        c.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new EngineError(msg.error ?? 'the host could not complete the request', 502));
        break;
      }
      case 'request':
        void this.onRequest(c, msg as unknown as { id: string } & AgentRequest);
        break;
      case 'pong':
        break;
    }
  }

  /** Requests made by an operator on the host through the orchestrator-agent CLI. */
  private async onRequest(c: AgentConn, req: { id: string } & AgentRequest): Promise<void> {
    const eng = this.engine;
    try {
      let result: unknown;
      // A member's own computer asks for itself only. Its agent may name an employee who already lives on that
      // computer, or a new one — never one of the shared office or of another member (their messages and the
      // office's tools would follow them to this machine), never the foreman, and never the level only an owner gives.
      const personal = eng.hosts.memberOfHost(c.hostId);
      const mine = (name: unknown) => {
        if (!personal || typeof name !== 'string' || !name) return;
        const existing = eng.core.employeeByName(name);
        if (!existing) return;
        if (existing.hostId !== c.hostId || existing.roleKey === FOREMAN_ROLE) throw new Error(`"${existing.name}" is not an employee on this computer. From a member's own computer only its own employees can be named; choose another name for a new one.`);
      };
      if (personal && req.method === 'create' && req.params.autonomy === 'unrestricted') throw new Error('Unrestricted is an owner\'s level to give, in the office (the employee\'s profile).');
      if (personal && (req.method === 'bind' || req.method === 'create') && (roleByKey((req.params as { role?: string }).role ?? '') ?? matchRole((req.params as { role?: string }).role ?? ''))?.key === FOREMAN_ROLE) throw new Error('The foreman belongs to the office; it cannot be created from a member\'s own computer.');
      switch (req.method) {
        case 'bind': {
          const session = eng.core.sessions.get(req.params.sessionId);
          if (!session || session.hostId !== c.hostId) throw new Error('unknown session');
          if (!req.params.employee) {
            result = { session, employee: null, created: false };
            break;
          }
          mine(req.params.employee);
          const { employee, created } = eng.employees.findOrCreate(req.params.employee, req.params.role, c.hostId);
          eng.sessions.bind(session.id, employee.id, `host:${c.hostId}`);
          result = { session, employee: { id: employee.id, name: employee.name, title: employee.title }, created };
          break;
        }
        case 'create': {
          // `orchestrator-agent create --name X --project <dir>`: X lives in that folder and owns the project in it.
          const actor = `host:${c.hostId}`;
          if (req.params.autonomy && !isAutonomyLevel(req.params.autonomy)) throw new Error(`unknown level "${req.params.autonomy}": it is one of ${AUTONOMY_LEVELS.join(', ')}`);
          const role = req.params.role ? (roleByKey(req.params.role) ?? matchRole(req.params.role)) : undefined;
          if (req.params.role && !role) throw new Error(`unknown role "${req.params.role}". Known roles: ${ROLE_CATALOGUE.map((r) => r.key).join(', ')}`);
          mine(req.params.name);
          let employee = eng.core.employeeByName(req.params.name);
          if (!employee) {
            employee = await eng.hire({ name: req.params.name, roleKey: role?.key ?? null, hostId: c.hostId, workingDir: req.params.project, model: req.params.model ?? null, ...(req.params.autonomy ? { autonomy: req.params.autonomy as any } : {}) }, actor);
          } else if (!eng.core.runningSessionOf(employee.id)) {
            const project = eng.core.projects.find((p) => p.hostId === c.hostId && p.repoPath === req.params.project);
            eng.employees.update(employee.id, { hostId: c.hostId, ...(project ? { projectId: project.id } : { workingDir: req.params.project }), ...(req.params.model ? { model: req.params.model } : {}), ...(req.params.autonomy ? { autonomy: req.params.autonomy as any } : {}) }, actor);
          }
          const session = await eng.sessions.start(employee.id, { actor });
          result = { employee: { id: employee.id, name: employee.name, title: employee.title }, session: { id: session.id, tmuxSession: session.tmuxSession, cwd: session.cwd } };
          break;
        }
        case 'status':
          result = {
            employees: eng.core.employees
              .filter((e) => !e.archived && e.hostId === c.hostId)
              .map((e) => ({ name: e.name, title: e.title, activity: eng.core.runningSessionOf(e.id)?.activity ?? 'offline', task: eng.tasks.currentTask(e.id)?.key ?? null })),
          };
          break;
        default:
          throw new Error(`unknown request ${(req as any).method}`);
      }
      this.sendTo(c, { t: 'response', id: req.id, ok: true, result });
    } catch (e) {
      this.sendTo(c, { t: 'response', id: req.id, ok: false, error: (e as Error).message });
    }
  }
}

interface ClientConn {
  id: string;
  ws: WebSocket;
  who: Who;
  /** Set when this window came in with a password sign-in session: which one (see `Logins.keyOf`). */
  loginKey?: string;
  /** This window is being closed by the office: nothing it still sends is acted on. */
  dropped?: boolean;
  /** Where their character is, once they have said so. */
  presence: { x: number; z: number; rot: number; moving: boolean; at?: number; sit?: boolean; out?: OutsideAt } | null;
  /** When their character last jumped (for the rate limit). */
  jumpedAt?: number;
  /** When this window last cracked the whip. */
  whippedAt?: number;
  /** When this window's character last made a gesture. */
  emotedAt?: number;
  /** Frames of voice in the current second (for the rate limit), and whether they are talking right now. */
  voice?: { since: number; frames: number; on: boolean };
  /** When they last spoke (for the rate limit). */
  said: number[];
  /**
   * When this window last said its person is here — in front of it, using it (`here`, every minute while so). Absent:
   * not here (another window in front, hidden, or nothing touched for a while). Read by `isHere`.
   */
  hereAt?: number;
}

/** A window that said its person is here counts for this long without saying it again (it says it every minute). */
export const HERE_FOR_MS = 150_000;

/** Connections from office UIs (the desktop app or a browser). */
export class ClientHub {
  private clients = new Map<string, ClientConn>();
  private engine!: Engine;
  private log: Log;

  /** A showcase office (`ServerOptions.showcase`): visitors only watch. */
  private readonly showcase: boolean;

  constructor(log: Log, opts: { showcase?: boolean } = {}) {
    this.log = log;
    this.showcase = !!opts.showcase;
  }

  attach(engine: Engine): void {
    this.engine = engine;
    engine.core.bus.on('entity', (kind: EntityKind, op: 'upsert' | 'remove', data: unknown) => this.broadcast({ t: 'entity', kind, op, data }));
    engine.core.bus.on('event', (event: OrchestratorEvent) => this.broadcast({ t: 'event', event }));
  }

  get size(): number {
    return this.clients.size;
  }

  private closing = false;

  close(): void {
    this.closing = true;
    for (const c of this.clients.values()) {
      try {
        c.ws.close(1001, 'server shutting down');
        setTimeout(() => c.ws.terminate(), 200).unref();
      } catch {
        /* ignore */
      }
    }
  }

  send(clientId: string, msg: ServerToClient): void {
    const c = this.clients.get(clientId);
    if (!c || c.ws.readyState !== 1) return;
    // What is on a member's own computer is shown to that member and to owners only.
    if (msg.t.startsWith('term.') && msg.t !== 'term.closed') {
      const about = (msg as { sessionId?: unknown }).sessionId ?? (msg as { snapshot?: { sessionId?: unknown } }).snapshot?.sessionId;
      if (typeof about === 'string' && !maySee(this.engine, c.who, about)) return;
    }
    // Monitor frames are disposable; never let them pile up behind a slow client.
    if (msg.t === 'term.screen' && c.ws.bufferedAmount > 4 * 1024 * 1024) return;
    try {
      c.ws.send(JSON.stringify(msg));
    } catch {
      /* closed underneath us */
    }
  }

  /**
   * What is said on a member's own computer goes to that member and the owners only, and the foreman's rounds to
   * everyone only in outline (see `access.ts`): the message as this connection gets it, or null for not at all.
   */
  private heardBy(c: ClientConn, msg: ServerToClient): ServerToClient | null {
    // A notification addressed to some people reaches their windows only (an owner's too).
    if (msg.t === 'entity' && msg.kind === 'notification' && msg.op === 'upsert' && !notificationFor(msg.data as Notification, { id: c.who.id, owner: c.who.kind === 'owner' })) return null;
    // An owner hears everything, except from a room its member has closed.
    if (c.who.kind === 'owner' && !this.engine.hosts.closedMembers().some((id) => id !== c.who.id)) return msg;
    // A visitor is sent each thing with only what a visitor may know of it, or not at all.
    if (msg.t === 'entity' && c.who.role === 'visitor') {
      const data = shownTo(this.engine, c.who, msg.kind, msg.data, msg.op);
      return data === msg.data ? msg : data === null ? null : { ...msg, data };
    }
    if (msg.t === 'event') {
      const event = eventFor(this.engine, c.who, msg.event);
      return event === msg.event ? msg : event ? { t: 'event', event } : null;
    }
    if (msg.t === 'entity' && msg.op === 'upsert' && msg.kind === 'message') return mayReadMessage(this.engine, c.who, msg.data) ? msg : null;
    if (msg.t === 'entity' && msg.op === 'upsert' && msg.kind === 'question') return mayReadQuestion(this.engine, c.who, msg.data) ? msg : null;
    if (msg.t === 'entity' && msg.op === 'upsert' && msg.kind === 'routine') return mayReadRoutine(this.engine, c.who, msg.data) ? msg : null;
    return msg;
  }

  broadcast(msg: ServerToClient): void {
    if (!this.clients.size) return;
    const text = JSON.stringify(msg);
    const scoped = msg.t === 'event' || (msg.t === 'entity' && (msg.kind === 'message' || msg.kind === 'question' || msg.kind === 'routine' || (msg.kind === 'notification' && !!(msg.data as Notification).for?.length)));
    for (const c of this.clients.values()) {
      const mine = scoped || (msg.t === 'entity' && c.who.role === 'visitor') ? this.heardBy(c, msg) : msg;
      if (!mine) continue;
      if (c.ws.readyState === 1) {
        try {
          c.ws.send(mine === msg ? text : JSON.stringify(mine));
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Is this person (a member's id, or "owner") in the office now — a window of theirs open, in front, and used in the
   * last minutes? While so, what employees send them goes to the office only, not to their Telegram (the owner,
   * 2026-11-23: "when I am present in the office, the agents must not send me messages on Telegram").
   */
  isHere(personId: string, now = Date.now()): boolean {
    for (const c of this.clients.values()) if (c.who.id === personId && !c.dropped && c.ws.readyState === 1 && c.hereAt && now - c.hereAt < HERE_FOR_MS) return true;
    return false;
  }

  /** Everyone present, for a client that asks over HTTP. */
  people(): PersonPresence[] {
    return [...this.clients.values()].filter((c) => c.presence).map((c) => {
      const look = this.characters?.get(c.who.id);
      return { id: c.id, name: c.who.name, role: c.who.role, memberId: c.who.id, hue: hueOf(c.who.id), ...c.presence!, ...(look ? { look } : {}) };
    });
  }

  /**
   * Close the windows a member has open through a password sign-in that has ended — all of them (`key` absent: the
   * password was changed or taken away) or the one of that session (signed out). Windows that came in with the
   * member's own credential (the desktop app) are not touched. The page then shows the sign-in again.
   */
  dropLogins(guestId: string, key?: string): void {
    for (const c of this.clients.values()) if (c.who.id === guestId && c.loginKey && (!key || c.loginKey === key)) this.shut(c, 'signed out');
  }

  /**
   * Close a window whose right to be here has ended. A polite close waits for the other side to agree (up to half a
   * minute); until then nothing more is taken from it, and after two seconds the connection is cut.
   */
  private shut(c: ClientConn, reason: string): void {
    c.dropped = true;
    c.ws.close(4003, reason);
    setTimeout(() => c.ws.terminate(), 2000).unref?.();
  }

  /** Close every window of a guest whose access was revoked. */
  dropGuest(guestId: string): void {
    for (const c of this.clients.values()) if (c.who.id === guestId) this.shut(c, 'access revoked');
  }

  /** Who is at the door: told to those who may let someone in (owners and colleagues), now and when they walk in. */
  private atDoor: KnockView[] = [];
  private answers(c: ClientConn): boolean {
    return c.who.kind === 'owner' || c.who.role === 'colleague';
  }
  knocks(list: KnockView[]): void {
    this.atDoor = list;
    for (const c of this.clients.values()) if (this.answers(c)) this.send(c.id, { t: 'knocks', knocks: list });
  }
  /** Is anyone inside who could answer the door? */
  someoneToAnswer(): boolean {
    return [...this.clients.values()].some((c) => this.answers(c));
  }

  /** What the office's hi-fi is playing: told to everyone, now and when they walk in (see `HiFi` in `radio.ts`). */
  /** The arcade: the shelf of games (given by the server once it has its data folder) and the tables. */
  private shelf: ArcadeShelf | null = null;
  readonly tables = new ArcadeTables({
    send: (clientId, msg) => this.send(clientId, msg),
    behind: (clientId) => this.clients.get(clientId)?.ws.bufferedAmount ?? 0,
    changed: () => this.arcadeChanged(),
  });
  private arcadeTimer: NodeJS.Timeout | null = null;
  setShelf(shelf: ArcadeShelf): void {
    this.shelf = shelf;
  }
  private arcadeNow(): ServerToClient {
    return { t: 'arcade', games: this.shelf?.list() ?? [], tables: this.tables.list() };
  }
  /** The shelf or a table changed: everyone is told, once for a burst of changes. */
  arcadeChanged(): void {
    if (this.arcadeTimer) return;
    this.arcadeTimer = setTimeout(() => {
      this.arcadeTimer = null;
      const msg = this.arcadeNow();
      for (const id of this.clients.keys()) this.send(id, msg);
    }, 40);
    this.arcadeTimer.unref();
  }

  private onAir: RadioNow | null = null;
  radio(now: RadioNow | null): void {
    this.onAir = now;
    this.broadcast({ t: 'radio', radio: now });
  }

  /** The last things said in the office (kept in memory only): shown to whoever walks in. */
  private recent: Array<{ from: { id: string; name: string; role: Who['role']; hue: number }; text: string; ts: string; emote?: boolean }> = [];
  private remember(line: (typeof this.recent)[number]): void {
    this.recent.push(line);
    if (this.recent.length > 40) this.recent.shift();
  }

  /** Whose movement (or arrival, or leaving: '*') has not been passed on yet. */
  /** Each person's own character (`characters.ts`): drawn for them in every window. Set by the server. */
  characters: Characters | null = null;

  /**
   * Somebody changed their character: every window is told (their own ones too — another window of theirs draws
   * them as well), and their own windows get it as theirs.
   */
  lookChanged(personId: string): void {
    const look = this.characters?.get(personId) ?? null;
    for (const c of this.clients.values()) if (c.who.id === personId) this.send(c.id, { t: 'me.look', look });
    this.schedulePeople('*');
  }

  private peopleMoved = new Set<string>();
  private peopleTimer: NodeJS.Timeout | null = null;

  /**
   * Tell everyone where everyone else is, at most ten times a second and only when something moved.
   * Nobody is told about their own movement: their own window already knows, and an office with one
   * person in it would otherwise hear its own steps back several times a second.
   */
  private schedulePeople(mover: string = '*'): void {
    this.peopleMoved.add(mover);
    if (this.peopleTimer) return;
    this.peopleTimer = setTimeout(() => {
      this.peopleTimer = null;
      const moved = this.peopleMoved;
      this.peopleMoved = new Set();
      if (!moved.size) return;
      const people = this.people();
      for (const id of this.clients.keys()) if (moved.has('*') || moved.size > 1 || !moved.has(id)) this.send(id, { t: 'people', people });
    }, 100);
    this.peopleTimer.unref();
  }

  handle(ws: WebSocket, who: Who = { kind: 'owner', id: 'owner', name: 'Owner', role: 'owner' }, loginKey: string | null = null, until: string | null = null): void {
    if (this.closing) return void ws.terminate();
    // A window that came in with a sign-in is over when that sign-in runs out (a timer cannot be set further ahead
    // than about 24 days; a window open for longer than that is closed by the next restart of the office anyway).
    const left = until ? Date.parse(until) - Date.now() : NaN;
    if (Number.isFinite(left) && left < 2 ** 31 - 1) {
      const end = setTimeout(() => ws.close(4003, 'signed out'), Math.max(0, left));
      end.unref?.();
      ws.on('close', () => clearTimeout(end));
    }
    const id = crypto.randomUUID();
    const conn: ClientConn = { id, ws, who, presence: null, said: [], ...(loginKey ? { loginKey } : {}) };
    this.clients.set(id, conn);
    const gateway = this.engine.core.gateway;
    this.send(id, { t: 'ready', clientId: id, state: stateFor(this.engine, who, this.engine.state()), me: { kind: who.kind, role: who.role, name: who.name, id: who.id, look: this.characters?.get(who.id) ?? null, hue: hueOf(who.id) }, ...(this.showcase ? { showcase: true } : {}) });
    // Everyone gets the live monitors of what they may see (`send` leaves out the rest: other members' own computers).
    gateway.registerClient(id);
    const actor = who.id === 'owner' ? `owner:${id.slice(0, 8)}` : `member:${who.name}`;
    const drive = (sessionId: string, what: string): boolean => {
      if (mayDrive(this.engine, who, sessionId)) return true;
      this.send(id, { t: 'error', message: who.role === 'visitor' ? `You are visiting this office: you cannot ${what}.` : `That terminal is on another member's own computer: you cannot ${what}.`, ref: sessionId });
      return false;
    };
    if (this.clients.size > 1) this.send(id, { t: 'people', people: this.people() });
    // What was said in the last hour, so the chat is not empty for someone who has just walked in.
    const since = Date.now() - 3600_000;
    const lines = this.recent.filter((l) => Date.parse(l.ts) > since);
    if (lines.length) this.send(id, { t: 'chat.history', lines });
    if (this.atDoor.length && this.answers(conn)) this.send(id, { t: 'knocks', knocks: this.atDoor });
    // Always said, also when it is off: a window that comes back after the office restarted must not go on playing.
    this.send(id, { t: 'radio', radio: this.onAir });
    this.send(id, this.arcadeNow());

    ws.on('message', (data) => {
      let msg: ClientToServer;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || conn.dropped) return;
      const fail = (e: unknown, ref?: string) => this.send(id, { t: 'error', message: (e as Error).message, ref });
      try {
        switch (msg.t) {
          case 'here':
            // Its person is in front of this window and using it, or no longer (`isHere`; Telegram waits while so).
            conn.hereAt = msg.active === true ? Date.now() : undefined;
            break;
          case 'presence': {
            const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-500, Math.min(500, v)) : 0);
            const first = !conn.presence;
            // Out in the city (docs/CITY.md, "Together"): where they are there, passed on to everybody as it is.
            const out = cleanOutside(msg.out);
            conn.presence = { x: n(msg.x), z: n(msg.z), rot: n(msg.rot), moving: msg.moving === true, ...(typeof msg.at === 'number' && Number.isFinite(msg.at) ? { at: msg.at } : {}), ...(msg.sit === true ? { sit: true } : {}), ...(out ? { out } : {}) };
            // The first report is news for everyone (the list each client keeps includes itself); after that, only for the others.
            this.schedulePeople(first ? '*' : id);
            break;
          }
          case 'say': {
            // People talking to each other. Short, and not faster than a person types.
            const text = String(msg.text ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300);
            const now = Date.now();
            conn.said = conn.said.filter((t) => now - t < 10_000);
            if (!text || conn.said.length >= 8) break;
            conn.said.push(now);
            const line = { from: { id, name: who.name, role: who.role, hue: hueOf(who.id) }, text, ts: new Date(now).toISOString() };
            this.remember(line);
            this.broadcast({ t: 'said', ...line });
            break;
          }
          case 'whip': {
            // A gag everyone sees: the person swings, whoever it was meant for yelps. One crack has to land before the next.
            const now = Date.now();
            if (now - (conn.whippedAt ?? 0) < 600) break;
            const from = { id, name: who.name, role: who.role, hue: hueOf(who.id) };
            const ts = new Date(now).toISOString();
            if (typeof msg.personId === 'string') {
              // At another person: only someone standing next to them (a whip is two metres long, not an office wide).
              const victim = this.clients.get(msg.personId);
              if (!victim || victim.id === id || !victim.presence || !conn.presence) break;
              if (apart(victim.presence, conn.presence) > 4.5) break;
              conn.whippedAt = now;
              this.remember({ from, text: `cracks the whip at ${victim.who.name}`, ts, emote: true });
              this.broadcast({ t: 'whipped', from, personId: victim.id, ts });
              break;
            }
            const employee = this.engine.core.employees.get(String(msg.employeeId ?? ''));
            if (!employee || employee.archived) break;
            conn.whippedAt = now;
            // Where the owners switched it on: the crack approves what that employee is waiting for permission to do —
            // for someone who may decide it anyway (the same rule as the Inbox: `access.ts`), and on the record as theirs.
            let approved = 0;
            if (this.engine.core.settings.whipApproves === true) {
              for (const q of this.engine.core.questions.filter((x) => x.employeeId === employee.id && x.kind === 'permission' && x.status === 'open')) {
                if (!mayCall(this.engine, who, 'POST', `/questions/${q.id}/answer`, null).ok) continue;
                approved++;
                void this.engine.comms.answer(q.id, { decision: 'allow' }, who.id === 'owner' ? 'owner' : `member:${who.name}`).catch((e) => this.log('warn', `the whip could not approve ${q.id}: ${(e as Error).message}`));
              }
            }
            // Somebody asleep, or not at their desk at all, is got up by it: their session is started, or the one they
            // left is taken up again. Only for whoever may start that employee anyway (the Start button's own rule), and
            // only when they can be started — otherwise it stays a crack. On the record as the office waking them.
            let woke = false;
            if (!this.engine.core.runningSessionOf(employee.id) && mayCall(this.engine, who, 'POST', `/employees/${employee.id}/start`, null).ok && !this.engine.sessions.cannotStart(employee)) {
              woke = true;
              void this.engine.sessions.wake(employee.id, `${who.id === 'owner' ? 'the boss' : who.name}, who came to get them up`).catch((e) => this.log('warn', `${employee.name} could not be got up: ${(e as Error).message}`));
            }
            const what = [approved ? `approves what ${approved === 1 ? 'was' : 'they'} asked` : '', woke ? 'gets them up' : ''].filter(Boolean).join(', and ');
            this.remember({ from, text: `cracks the whip at ${employee.name}${what ? ` — and ${what}` : ''}`, ts, emote: true });
            this.broadcast({ t: 'whipped', from, employeeId: employee.id, ...(approved ? { approved } : {}), ...(woke ? { woke } : {}), ts });
            break;
          }
          case 'jump': {
            // Their character jumped: seen by everyone who sees them. Not faster than a person can land.
            const now = Date.now();
            if (!conn.presence || now - (conn.jumpedAt ?? 0) < 350) break;
            conn.jumpedAt = now;
            this.broadcast({ t: 'jumped', from: id });
            break;
          }
          case 'emote': {
            // A gesture of their character, seen by everyone. Not faster than a person can pick one.
            const now = Date.now();
            if (!isEmote(msg.name) || now - (conn.emotedAt ?? 0) < 400) break;
            conn.emotedAt = now;
            this.broadcast({ t: 'emoted', from: { id, name: who.name, role: who.role, hue: hueOf(who.id) }, name: msg.name, ts: new Date(now).toISOString() });
            break;
          }
          case 'voice': {
            // In a showcase, open to anybody, nobody's voice is passed on.
            if (this.showcase && who.id !== 'owner') break;
            // A frame of their voice: passed on to those within earshot of their character, and kept nowhere.
            if (!conn.presence || !validFrame(msg.data)) break;
            const now = Date.now();
            const v = (conn.voice ??= { since: now, frames: 0, on: false });
            if (now - v.since >= 1000) {
              v.since = now;
              v.frames = 0;
            }
            if (++v.frames > VOICE_FRAMES_PER_SECOND) break;
            v.on = true;
            const frame = JSON.stringify({ t: 'voice', from: id, seq: Number(msg.seq) || 0, data: msg.data } satisfies ServerToClient);
            const layout = this.engine.core.layout;
            for (const c of this.clients.values()) {
              if (c.id === id || !c.presence || c.ws.readyState !== 1 || !hears(layout, conn.presence, c.presence)) continue;
              try {
                c.ws.send(frame);
              } catch {
                /* ignore */
              }
            }
            break;
          }
          // The arcade's tables (`arcade.ts`): who plays with whom, and the host's picture and sound passed on.
          case 'arcade.open':
            this.tables.open({ id, name: who.name }, msg.title, msg.gameId);
            break;
          case 'arcade.close':
            this.tables.close(id);
            break;
          case 'arcade.join':
            this.tables.join({ id, name: who.name }, msg.table, msg.as);
            break;
          case 'arcade.leave':
            this.tables.leave(id);
            break;
          case 'arcade.media':
            this.tables.media(id, msg.kind, msg.key, msg.ts, msg.data);
            break;
          case 'arcade.pad':
            this.tables.pad(id, msg.button, msg.down);
            break;
          case 'arcade.key':
            this.tables.key(id);
            break;
          case 'voice.end': {
            if (!conn.voice?.on) break;
            conn.voice.on = false;
            // To everyone: who was in earshot a moment ago may have walked on, and "they stopped" is no secret.
            this.broadcast({ t: 'voice.end', from: id });
            break;
          }
          case 'term.open':
            if (!maySee(this.engine, who, msg.sessionId)) {
              this.send(id, { t: 'term.closed', sessionId: msg.sessionId, reason: "This terminal is on another member's own computer." });
              break;
            }
            gateway.open(id, msg.sessionId).catch((e) => {
              fail(e, msg.sessionId);
              this.send(id, { t: 'term.closed', sessionId: msg.sessionId, reason: (e as Error).message });
            });
            break;
          case 'term.close':
            gateway.close(id, msg.sessionId);
            break;
          case 'term.input':
            if (!drive(msg.sessionId, 'type into a terminal')) break;
            gateway.input(id, msg.sessionId, msg.data).catch((e) => fail(e, msg.sessionId));
            break;
          case 'term.resize':
            if (!mayDrive(this.engine, who, msg.sessionId)) break;
            gateway.resize(id, msg.sessionId, msg.cols, msg.rows).catch((e) => fail(e, msg.sessionId));
            break;
          case 'term.widen': {
            // Whoever may work with the session may have its pane grow to their window (see the gateway's `widen`).
            if (!mayDrive(this.engine, who, msg.sessionId)) break;
            const s = this.engine.core.sessions.get(msg.sessionId);
            if (!s || s.mode !== 'interactive_cli') break;
            gateway.widen(id, msg.sessionId, Number(msg.cols), Number(msg.rows), { cols: s.cols, rows: s.rows }).catch((e) => fail(e, msg.sessionId));
            break;
          }
          case 'control.acquire':
            if (this.engine.core.sessions.get(msg.sessionId)?.mode === 'codex_managed') break;
            if (!drive(msg.sessionId, 'take control of a terminal')) break;
            gateway.acquire(id, msg.sessionId, actor);
            break;
          case 'control.release':
          case 'control.observe':
            gateway.release(id, msg.sessionId, actor);
            break;
          case 'screens.focus':
            if (!msg.sessionId || maySee(this.engine, who, msg.sessionId)) gateway.setFocus(id, msg.sessionId);
            break;
          case 'ping':
            this.send(id, { t: 'pong' });
            break;
        }
      } catch (e) {
        fail(e, (msg as { sessionId?: string } | null)?.sessionId);
      }
    });
    ws.on('close', () => {
      // Control is released automatically when its holder disappears.
      gateway.clientGone(id);
      this.clients.delete(id);
      // Their table is over, and their seat at somebody else's is free.
      this.tables.gone(id);
      // Someone who went away in the middle of a sentence has stopped talking.
      if (conn.voice?.on) this.broadcast({ t: 'voice.end', from: id });
      if (conn.presence) this.schedulePeople();
    });
    ws.on('error', () => undefined);
  }
}
