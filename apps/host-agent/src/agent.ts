import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentRequest,
  AgentRpc,
  AgentSessionReport,
  AgentToServer,
  ExecutionMode,
  HookPayload,
  HostInfo,
  HostResources,
  LaunchSpec,
  RawHookEvent,
  ServerToAgent,
  SessionCapabilities,
} from '@orchestrator/contracts';
import { HOOKS_VERSION, PROTOCOL_VERSION, redactSecrets, slugify } from '@orchestrator/contracts';
import type { AccountInfo, AccountLogin } from '@orchestrator/contracts';
import {
  NESTED_SESSION_ENV,
  PaneStream,
  ResourceSampler,
  Tmux,
  claudeVersion,
  claudeEffortLevels,
  findBrowserMcp,
  agentAwayMark,
  currentBranch,
  ensureWorktree,
  gitDiff,
  gitLog,
  gitStatus,
  inspectPath,
  listFolders,
  createFolder,
  listMarkdown,
  looksLikeClaude,
  mergeBranch,
  integrationStatus,
  promoteIntegration,
  planClaudeLaunch,
  type ClaudeLaunchPlan,
  readMarkdown,
  readLastSaid, readTranscriptUsage,
  readProcessTable,
  toolShells,
  runVerify,
  startBranch,
  commitWip,
} from '@orchestrator/execution';
import { AGENT_VERSION, type AgentConfig, paths, readJson, saveConfig, toWsUrl, writePrivate } from './config.ts';
import type { ManagedSpec } from './managed-runner.ts';
import { locateSdk } from './sdk.ts';

/** What the office can send to an SDK-managed worker without touching its terminal. */
type ManagedItem = { type: 'prompt'; text: string } | { type: 'interrupt' } | { type: 'exit' };

/** Hook events an SDK-managed worker reports (SDK hook callbacks plus the runner's own lifecycle and approval events). */
const MANAGED_HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PermissionRequest'];

/** How to start this same program again as a worker runner (bundle: itself; sources: cli.ts next to this file). */
function runnerCommand(): string[] {
  const self = fileURLToPath(import.meta.url);
  const entry = path.basename(self) === 'agent.ts' ? path.join(path.dirname(self), 'cli.ts') : self;
  // The office's own MCP tools are pre-approved by an allow rule, as they are for interactive
  // workers; the SDK's notice that such rules bypass the permission callback is expected here.
  return [process.execPath, '--disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED', entry, 'managed-run'];
}

interface Tracked {
  /** The name of the start this session's running process belongs to (null: its hooks do not say). */
  hookLaunch?: string | null;
  /** The version of the hook commands in this session's settings (`HOOKS_VERSION` when it was started). */
  hooksVersion?: number;
  sessionId: string;
  launchId?: string | null;
  origin: 'managed' | 'attached';
  mode: ExecutionMode;
  tmuxSession: string;
  paneId: string;
  cwd: string;
  claudeSessionId: string | null;
  hookToken: string | null;
  spec: LaunchSpec | null;
  startedAt: string;
  transcriptPath: string | null;
  hooksSeen: boolean;
  hookEvents: string[];
  permissionMode: string | null;
  alive: boolean;
  pid: number | null;
  command: string | null;
  cols: number;
  rows: number;
  branch: string | null;
  repoRoot: string | null;
  exitReason: string | null;
  gone: boolean;
}

interface Runtime {
  stream: PaneStream | null;
  subscribed: boolean;
  opening: Promise<void> | null;
  usageTimer: NodeJS.Timeout | null;
  /** SDK-managed workers: prompts and interrupts waiting for the runner to collect. */
  inbox: ManagedItem[];
  inboxWaiter: (() => void) | null;
  /** SDK-managed workers: the running cost estimate last reported by the SDK. */
  costUsdEstimate: number | null;
  /** Exact tool calls the owner allowed once after Claude Code refused them (see `session.grant`). */
  grants?: Array<{ key: string; until: number }>;
}

interface PendingHook {
  resolve: (output: Record<string, unknown> | null) => void;
  timer: NodeJS.Timeout;
  /** What was sent, so it can be sent again if the connection drops before the server answers. */
  event?: RawHookEvent;
  /**
   * A request somebody may be deciding (a permission, a question, a held high-risk call): kept through a short loss
   * of the office — its restart, a blip — and sent again when the office is back, so that the employee does not
   * fall to Claude Code's own prompt in the terminal because of a deploy.
   */
  keep?: boolean;
}

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

const OUTBOX_LIMIT = 5000;

/** Where Claude Code is sent for Z.AI's GLM Coding Plan (their instructions: docs.z.ai/devpack/tool/claude). */
const ZAI_BASE_URL = 'https://api.z.ai/api/anthropic';
/** The keys the office may press in a sign-in's terminal, by the names it uses for them. */
const LOGIN_KEYS: Record<string, string> = { enter: 'Enter', up: 'Up', down: 'Down', left: 'Left', right: 'Right', escape: 'Escape', tab: 'Tab', backspace: 'BSpace', space: 'Space' };

/** Does this Claude Code have the `auth login` command? Its own help says so; an older one answers with its general help. */
function hasAuthLogin(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['auth', '--help'], { encoding: 'utf8', timeout: 15000 }, (err, stdout) => resolve(!err && /\blogin\b/.test(stdout) && /authentication/i.test(stdout)));
  });
}

/**
 * The host agent daemon. It owns nothing but observation and delivery: tmux
 * sessions keep running whether or not this process (or the server) is alive.
 */
/** What makes two tool calls "the same call": for a shell command its text, otherwise the tool and its whole input. */
export function grantKey(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (tool === 'Bash' && typeof i.command === 'string') return `Bash\u0000${i.command.trim()}`;
  const { description: _d, ...rest } = i;
  return `${tool}\u0000${JSON.stringify(rest, Object.keys(rest).sort())}`;
}

export class HostAgent {
  readonly cfg: AgentConfig;
  readonly home: string;
  readonly p: ReturnType<typeof paths>;
  readonly tmux: Tmux;
  /** Sign-ins to Claude accounts run on a tmux server of their own: they are not sessions, and are never found as one. */
  private readonly loginTmux: Tmux;
  private ws: WebSocket | null = null;
  private connected = false;
  private stopping = false;
  private reconnectDelay = 500;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = Date.now();
  private tracked = new Map<string, Tracked>();
  private runtime = new Map<string, Runtime>();
  private outbox: RawHookEvent[] = [];
  private outboxDirty = false;
  private hostSeq = Date.now() * 1000;
  private pendingHooks = new Map<string, PendingHook>();
  /** Runs while the office is gone but may be back in a moment (see `dropLink`); null when connected or given up. */
  private linkGrace: NodeJS.Timeout | null = null;
  private pendingRequests = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private hookServer: http.Server | null = null;
  private timers: NodeJS.Timeout[] = [];
  private sampler = new ResourceSampler();
  private info: HostInfo | null = null;
  private tickCount = 0;
  private ticking = false;
  /** What was last told the office about each session's command shells (their pids), so that only changes are sent. */
  private shellsSent = new Map<string, string>();
  private rejected: string | null = null;
  log: Logger;
  onWelcome: (() => void) | null = null;

  constructor(cfg: AgentConfig, home: string, log?: Logger) {
    this.cfg = cfg;
    this.home = home;
    this.p = paths(home);
    this.tmux = new Tmux({ socketName: cfg.tmuxSocketName });
    this.loginTmux = new Tmux({ socketName: `${cfg.tmuxSocketName ?? 'orchestrator'}-login` });
    this.log = log ?? ((level, msg) => console.error(`[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`));
  }

  // ───────────────────────── lifecycle ─────────────────────────

  async start(): Promise<void> {
    if (!this.cfg.serverUrl) throw new Error('not logged in: run `orchestrator-agent login --server <url> --token <enrollment-token>` first');
    this.info = await this.collectInfo();
    if (!this.info.tmuxVersion) this.log('warn', 'tmux was not found on PATH; sessions cannot be created or attached');
    this.loadState();
    // Until the office has answered for the first time, a request for a decision waits for it (as after a lost
    // link): a hook that was in flight while this agent was being restarted comes again at once — so this stands
    // before the socket is opened, not after.
    const graceMs = (this.cfg.linkGraceSeconds ?? 90) * 1000;
    if (graceMs > 0) {
      this.linkGrace = setTimeout(() => this.releaseHeld(), graceMs);
      this.linkGrace.unref();
    }
    await this.startHookServer();
    // Hooks that found nobody here stopped waiting for this agent (`hookCommand`); it is back.
    fs.rmSync(agentAwayMark(this.p.socket), { force: true });
    await this.reconcile();
    this.connect();
    this.timers.push(setInterval(() => void this.tick(), 2000));
    this.timers.push(setInterval(() => void this.reportResources(), 5000));
    this.timers.push(setInterval(() => this.persistOutbox(), 1500));
    this.timers.push(
      setInterval(() => {
        // The server pings every 20s; silence for a minute means the link is dead.
        if (this.ws && this.connected && Date.now() - this.lastMessageAt > 60000) {
          this.log('warn', 'server connection is silent; reconnecting');
          this.dropLink(this.ws);
        }
      }, 10000),
    );
    fs.writeFileSync(this.p.pid, String(process.pid));
  }

  async stop(): Promise<void> {
    // A sign-in somebody left open goes with the agent: it is of no use to anybody without it.
    for (const l of this.logins.values()) await this.loginTmux.killSession(l.name).catch(() => undefined);
    this.logins.clear();
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const rt of this.runtime.values()) rt.stream?.close();
    this.persistOutbox(true);
    this.saveState();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    // Release the runners' long-polls. A hook that is being held is not answered: its connection is closed below,
    // and the hook tries again — the agent that is started next takes the request up (see `hookCommand`).
    for (const rt of this.runtime.values()) rt.inboxWaiter?.();
    if (this.linkGrace) clearTimeout(this.linkGrace);
    this.linkGrace = null;
    for (const pending of this.pendingHooks.values()) clearTimeout(pending.timer);
    this.pendingHooks.clear();
    await new Promise<void>((r) => {
      if (!this.hookServer) return r();
      this.hookServer.close(() => r());
      this.hookServer.closeAllConnections();
    });
    try {
      fs.unlinkSync(this.p.socket);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(this.p.pid);
    } catch {
      /* ignore */
    }
  }

  private async collectInfo(): Promise<HostInfo> {
    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      agentVersion: AGENT_VERSION,
      hooksVersion: HOOKS_VERSION,
      saysHeldFor: true,
      tmuxVersion: await this.tmux.version(),
      claudeVersion: await claudeVersion(this.cfg.claudeBin),
      claudeEffortLevels: await claudeEffortLevels(this.cfg.claudeBin),
      browser: ((b) => (b ? { mcp: b.version, engine: b.engine } : null))(this.browserMcp()),
      cpus: os.cpus().length,
      totalMemBytes: os.totalmem(),
      user: os.userInfo().username,
      // Capability detection: SDK-managed workers are offered only where the Agent SDK is installed.
      runtimes: locateSdk(this.cfg, this.p.home) ? ['interactive_cli', 'managed_sdk'] : ['interactive_cli'],
    };
  }

  // ─────────────────────── persistence ────────────────────────

  private loadState(): void {
    const state = readJson<{ sessions: Tracked[] }>(this.p.state, { sessions: [] });
    for (const t of state.sessions ?? []) this.tracked.set(t.sessionId, t);
    this.outbox = readJson<RawHookEvent[]>(this.p.outbox, []);
  }

  private saveState(): void {
    writePrivate(this.p.state, JSON.stringify({ sessions: [...this.tracked.values()] }, null, 2));
  }

  private persistOutbox(force = false): void {
    if (!this.outboxDirty && !force) return;
    this.outboxDirty = false;
    try {
      writePrivate(this.p.outbox, JSON.stringify(this.outbox));
    } catch (e) {
      this.log('warn', `could not persist outbox: ${(e as Error).message}`);
    }
  }

  /** After a restart, pick the still-running tmux sessions back up. */
  private async reconcile(): Promise<void> {
    const panes = await this.tmux.listPanes().catch(() => []);
    for (const t of this.tracked.values()) {
      const pane = panes.find((p) => p.paneId === t.paneId && p.sessionName === t.tmuxSession);
      if (!pane) {
        t.alive = false;
        t.gone = true;
        t.exitReason = t.exitReason ?? 'tmux session no longer exists';
        continue;
      }
      t.gone = false;
      t.alive = !pane.dead;
      t.pid = pane.panePid;
      t.command = pane.currentCommand;
      t.cols = pane.width;
      t.rows = pane.height;
      await this.openStream(t).catch((e) => this.log('warn', `reattach ${t.tmuxSession}: ${e.message}`));
    }
    this.saveState();
  }

  // ───────────────────────── server link ───────────────────────

  private connect(): void {
    if (this.stopping) return;
    const url = toWsUrl(this.cfg.serverUrl!, '/ws/agent');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.log('error', `cannot open ${url}: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.lastMessageAt = Date.now();
      this.rawSend({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        hostId: this.cfg.hostId,
        credential: this.cfg.credential,
        name: this.cfg.name,
        info: this.info!,
      });
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let msg: ServerToAgent;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      void this.onMessage(msg).catch((e) => this.log('error', `handling ${msg.t}: ${e?.stack ?? e}`));
    };
    ws.onclose = () => this.dropLink(ws);
    // A connection that is accepted but never answers (a dead tunnel, a proxy with nothing behind it)
    // must not hold up the next attempt: no welcome within a few seconds means try again.
    const handshake = setTimeout(() => {
      if (this.ws === ws && !this.connected) {
        this.log('warn', `no answer from ${this.cfg.serverUrl} yet; trying again`);
        this.dropLink(ws);
      }
    }, 8000);
    handshake.unref();
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  /** This connection is over (closed, or given up on): clean up after it and schedule the next attempt. */
  private dropLink(ws: WebSocket): void {
    if (this.ws !== ws) return;
    const was = this.connected;
    this.connected = false;
    this.ws = null;
    try {
      ws.close();
    } catch {
      /* already closed, or still connecting */
    }
    for (const rt of this.runtime.values()) rt.subscribed = false;
    // The office was there a moment ago: for a while (its restart takes seconds) what waits for a decision goes on
    // waiting. If it is not back by then, those are let go as well (`releaseHeld`).
    const graceMs = (this.cfg.linkGraceSeconds ?? 90) * 1000;
    if (was && graceMs > 0 && !this.linkGrace && !this.stopping) {
      this.linkGrace = setTimeout(() => this.releaseHeld(), graceMs);
      this.linkGrace.unref();
    }
    // Other blocking hooks cannot be answered any more; let Claude Code fall back to its own dialog.
    for (const [id, pending] of this.pendingHooks) {
      if (pending.keep && this.linkGrace) continue;
      clearTimeout(pending.timer);
      // The server may never have seen this event (it was on the wire, or the server was just going down): it is
      // kept and sent again after reconnecting, like any event that could not be delivered. A turn that ended during
      // a restart would otherwise leave its session looking busy for good. The server ignores an event it already has.
      if (pending.event) this.enqueue(pending.event);
      pending.resolve(null);
      this.pendingHooks.delete(id);
    }
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('server connection lost'));
      this.pendingRequests.delete(id);
    }
    if (was) this.log('warn', 'disconnected from server; tmux sessions keep running');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer || this.rejected) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(15000, Math.round(this.reconnectDelay * 1.7));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private rawSend(msg: AgentToServer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** The office did not come back in time: what was kept waiting for it is let go, as at any lost connection. */
  private releaseHeld(): void {
    this.linkGrace = null;
    if (this.connected) return;
    for (const [id, pending] of this.pendingHooks) {
      clearTimeout(pending.timer);
      if (pending.event) this.enqueue(pending.event);
      pending.resolve(null);
      this.pendingHooks.delete(id);
    }
  }

  private send(msg: AgentToServer): boolean {
    return this.connected ? this.rawSend(msg) : false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get rejection(): string | null {
    return this.rejected;
  }

  private async onMessage(msg: ServerToAgent): Promise<void> {
    switch (msg.t) {
      case 'welcome': {
        this.connected = true;
        this.reconnectDelay = 500;
        // The office is told about every session's commands again (at the next look), whatever it had before.
        this.shellsSent.clear();
        if (msg.credential || msg.hostId !== this.cfg.hostId) {
          this.cfg.hostId = msg.hostId;
          if (msg.credential) this.cfg.credential = msg.credential;
          saveConfig(this.cfg, this.home);
        }
        this.log('info', `connected to ${this.cfg.serverUrl} as host "${msg.name}" (${msg.hostId})`);
        this.send({ t: 'sessions', sessions: [...this.tracked.values()].filter((t) => !t.gone || t.origin === 'managed').map((t) => this.report(t)) });
        for (const ev of this.outbox) this.send({ t: 'hook', event: ev });
        // What was kept waiting through the loss of the office: asked again, under the same name.
        if (this.linkGrace) clearTimeout(this.linkGrace);
        this.linkGrace = null;
        for (const [requestId, pending] of this.pendingHooks) if (pending.keep && pending.event) this.send({ t: 'hook.request', requestId, event: pending.event });
        for (const rt of this.runtime.values()) rt.stream?.requestScreen();
        void this.reportResources();
        this.onWelcome?.();
        break;
      }
      case 'rejected':
        this.rejected = msg.reason;
        this.log('error', `server rejected this host: ${msg.reason}`);
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        break;
      case 'ack': {
        const ids = new Set(msg.ids);
        const before = this.outbox.length;
        this.outbox = this.outbox.filter((e) => !ids.has(e.id));
        if (this.outbox.length !== before) this.outboxDirty = true;
        break;
      }
      case 'ping':
        this.rawSend({ t: 'pong' });
        break;
      case 'hook.response': {
        const pending = this.pendingHooks.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingHooks.delete(msg.requestId);
          pending.resolve(msg.output);
        }
        break;
      }
      case 'response': {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          if (msg.ok) pending.resolve(msg.result);
          else pending.reject(new Error(msg.error ?? 'request failed'));
        }
        break;
      }
      case 'rpc': {
        const { id } = msg;
        try {
          const result = await this.handleRpc(msg as unknown as AgentRpc);
          this.send({ t: 'rpc.result', id, ok: true, result });
        } catch (e) {
          this.send({ t: 'rpc.result', id, ok: false, error: (e as Error).message });
        }
        break;
      }
    }
  }

  /** Ask the server to do something on behalf of the local operator (CLI). */
  request<T = unknown>(req: AgentRequest, timeoutMs = 60000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      if (!this.send({ t: 'request', id, ...req } as AgentToServer)) return reject(new Error('not connected to the Orchestrator server'));
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('server did not answer in time'));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
    });
  }

  // ───────────────────────── sessions ──────────────────────────

  private capabilities(t: Tracked): SessionCapabilities {
    const hooks = t.origin === 'managed' ? t.hookEvents.length > 0 : t.hooksSeen;
    if (t.mode === 'managed_sdk') return { terminal: !t.gone, hooks: true, mcp: !!t.spec?.mcp, structuredApproval: true, structuredMessaging: true, usage: true };
    return {
      terminal: !t.gone,
      hooks,
      mcp: !!t.spec?.mcp,
      structuredApproval: hooks && (t.origin !== 'managed' || t.hookEvents.includes('PermissionRequest')),
      structuredMessaging: hooks && (t.origin !== 'managed' || t.hookEvents.includes('Stop')),
      usage: !!t.transcriptPath,
    };
  }

  private report(t: Tracked): AgentSessionReport {
    return {
      sessionId: t.sessionId,
      launchId: t.launchId ?? null,
      origin: t.origin,
      mode: t.mode,
      tmuxSession: t.tmuxSession,
      tmuxPane: t.paneId,
      cwd: t.cwd,
      repoRoot: t.repoRoot,
      branch: t.branch,
      pid: t.pid,
      alive: t.alive && !t.gone,
      command: t.command,
      cols: t.cols,
      rows: t.rows,
      claudeSessionId: t.claudeSessionId,
      capabilities: this.capabilities(t),
      permissionMode: t.permissionMode,
      // (A session started before this agent knew of versions runs with the first ones.)
      ...(t.origin === 'managed' && t.mode === 'interactive_cli' ? { hooksVersion: t.hooksVersion ?? 1 } : {}),
      model: t.spec?.model ?? null,
      startedAt: t.startedAt,
      exitReason: t.exitReason,
    };
  }

  private rt(sessionId: string): Runtime {
    let rt = this.runtime.get(sessionId);
    if (!rt) {
      rt = { stream: null, subscribed: false, opening: null, usageTimer: null, inbox: [], inboxWaiter: null, costUsdEstimate: null };
      this.runtime.set(sessionId, rt);
    }
    return rt;
  }

  private openStream(t: Tracked): Promise<void> {
    const rt = this.rt(t.sessionId);
    if (rt.stream) return Promise.resolve();
    if (rt.opening) return rt.opening;
    const stream = new PaneStream(this.tmux, t.tmuxSession, t.paneId, { screenIntervalMs: 900 });
    stream.on('output', (seq, data) => {
      if (rt.subscribed) this.send({ t: 'term.output', sessionId: t.sessionId, seq, data: data.toString('base64') });
    });
    stream.on('screen', (screen) => this.send({ t: 'term.screen', sessionId: t.sessionId, screen }));
    stream.on('resize', (cols, rows) => {
      t.cols = cols;
      t.rows = rows;
      this.send({ t: 'session', session: this.report(t) });
    });
    stream.on('resync', () => {
      // Our tmux client had to reattach: viewers need a fresh snapshot.
      this.send({ t: 'session', session: this.report(t) });
    });
    stream.on('closed', (reason) => {
      if (rt.stream === stream) rt.stream = null;
      this.log('info', `terminal stream for ${t.tmuxSession} closed: ${reason}`);
      void this.tick();
    });
    rt.opening = stream
      .open()
      .then(() => {
        rt.stream = stream;
        t.cols = stream.cols;
        t.rows = stream.rows;
      })
      .finally(() => {
        rt.opening = null;
      });
    return rt.opening;
  }

  private requireStream(sessionId: string): PaneStream {
    const stream = this.runtime.get(sessionId)?.stream;
    if (!stream || !stream.connected) throw new Error('session terminal is not available on this host');
    return stream;
  }

  private requireTracked(sessionId: string): Tracked {
    const t = this.tracked.get(sessionId);
    if (!t) throw new Error(`unknown session ${sessionId}`);
    return t;
  }

  /** Refuse to operate outside the directories this host was told to allow. */
  private assertAllowed(p: string): string {
    const abs = path.resolve(p);
    const real = realpathOfDeepestExisting(abs);
    const ok = this.cfg.allowedRoots.some((root) => {
      const r = realpathOfDeepestExisting(path.resolve(root));
      return real === r || real.startsWith(r + path.sep);
    });
    if (!ok) throw new Error(`path ${abs} is outside this host's allowed roots (${this.cfg.allowedRoots.join(', ')})`);
    return abs;
  }

  /** Sessions whose launch is in progress; the periodic monitor leaves them alone until it finishes. */
  private launching = new Set<string>();

  async createSession(sessionId: string, spec: LaunchSpec): Promise<AgentSessionReport> {
    this.launching.add(sessionId);
    try {
      return await this.launchSession(sessionId, spec);
    } finally {
      this.launching.delete(sessionId);
    }
  }

  private async launchSession(sessionId: string, spec: LaunchSpec): Promise<AgentSessionReport> {
    // Workers reach the office the way this agent does. That matters when the office is only
    // reachable from here through a tunnel (an SSH link): its own address means nothing on this machine.
    if (spec.mcp && this.cfg.serverUrl) {
      const mine = new URL(this.cfg.serverUrl);
      const theirs = new URL(spec.mcp.url);
      mine.protocol = mine.protocol === 'wss:' ? 'https:' : mine.protocol === 'ws:' ? 'http:' : mine.protocol;
      if (mine.origin !== theirs.origin) spec = { ...spec, mcp: { ...spec.mcp, url: `${mine.origin}${theirs.pathname}` } };
    }
    // A Claude account of its own: the config folder must be this user's, and Claude Code must have been logged in there.
    if (spec.env?.CLAUDE_CONFIG_DIR) {
      const raw = spec.env.CLAUDE_CONFIG_DIR;
      const dir = path.resolve(raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
      if (dir !== os.homedir() && !dir.startsWith(os.homedir() + path.sep)) throw new Error(`the Claude account folder must be inside your home folder on this machine (${dir})`);
      if (!fs.existsSync(path.join(dir, '.claude.json'))) throw new Error(`nobody is logged in to Claude Code in ${dir} on this machine yet. Log in there once: CLAUDE_CONFIG_DIR=${dir} claude`);
      // The office knows this account by the folder as the owner wrote it; that name is what gets reported back.
      spec = { ...spec, env: { ...spec.env, CLAUDE_CONFIG_DIR: dir, ORCH_CLAUDE_ACCOUNT: raw } };
    }
    const cwd = this.assertAllowed(spec.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`working directory does not exist: ${cwd}`);
    // Additional repositories obey the same limits as the working directory.
    {
      const dirs = (spec.addDirs ?? []).map((d) => this.assertAllowed(d));
      for (const d of dirs) if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error(`additional repository does not exist on this machine: ${d}`);
      // The files people attach to tasks are kept in a folder of this agent's own; every session may read there.
      fs.mkdirSync(this.filesRoot(), { recursive: true, mode: 0o700 });
      spec = { ...spec, addDirs: [...new Set([...dirs, this.filesRoot()])] };
    }
    const sdk = spec.mode === 'managed_sdk' ? locateSdk(this.cfg, this.p.home) : null;
    if (spec.mode === 'managed_sdk' && !sdk) throw new Error('the Claude Agent SDK is not installed on this host (run `orchestrator-agent sdk install`, then restart the agent)');
    if (spec.mode !== 'interactive_cli' && spec.mode !== 'managed_sdk') throw new Error(`execution mode ${spec.mode} is not supported by this host agent`);
    const version = this.info?.claudeVersion ?? (await claudeVersion(this.cfg.claudeBin));
    if (!version) throw new Error(`Claude Code CLI not found (${this.cfg.claudeBin}); install it or set claudeBin in the agent config`);

    const existing = this.tracked.get(sessionId);
    const panes = await this.tmux.listPanes();
    const existingPane = existing ? panes.find((p) => p.paneId === existing.paneId && p.sessionName === existing.tmuxSession) : undefined;
    if (existing && existingPane && !existingPane.dead) throw new Error('session is already running');

    const sessionDir = path.join(this.p.sessions, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const hookToken = existing?.hookToken ?? crypto.randomBytes(24).toString('hex');
    // This start's own name: hooks of the process started now carry it, and hooks that carry another one come from
    // a process of an earlier start (see `onHook`).
    const hookLaunch = crypto.randomBytes(9).toString('hex');
    const plan = sdk
      ? this.planManagedLaunch({ ...spec, cwd }, sessionId, sessionDir, hookToken, sdk.entry)
      : planClaudeLaunch({
          claudeBin: this.cfg.claudeBin,
          spec: { ...spec, cwd },
          sessionId,
          sessionDir,
          hookSocket: this.p.socket,
          hookToken,
          claudeVersion: version,
          approvalWaitSeconds: this.cfg.approvalWaitSeconds,
          hookEvents: this.cfg.hookEvents,
          hookRetrySeconds: this.cfg.hookRetrySeconds,
          hookLaunch,
          effortLevels: spec.effort ? (this.info?.claudeEffortLevels ?? (await claudeEffortLevels(this.cfg.claudeBin))) : null,
          browser: spec.browser ? this.browserMcp() : null,
        });
    for (const f of plan.files) {
      writePrivate(f.path, f.content);
      const mode = (f as { mode?: number }).mode;
      if (mode) fs.chmodSync(f.path, mode);
    }
    // Anything queued for a previous run of this worker is stale now.
    const rt = this.rt(sessionId);
    rt.inbox = [];
    rt.costUsdEstimate = null;

    let tmuxSession: string;
    let paneId: string;
    // Whatever was streaming the previous incarnation's pane is over, whether that pane is reused or gone.
    rt.stream?.close();
    rt.stream = null;
    // From here on the hooks that count are those of the process started now (its first one may arrive before
    // this function has finished).
    if (existing && !sdk) existing.hookLaunch = hookLaunch;
    if (existing && existingPane) {
      // Same tmux session, same pane, scrollback preserved: only the dead process is restarted.
      tmuxSession = existing.tmuxSession;
      paneId = existing.paneId;
      await this.tmux.respawnPane(paneId, cwd, plan.run ?? plan.argv);
    } else {
      tmuxSession = `orch-${slugify(spec.displayName, 24)}-${sessionId.slice(0, 6)}`;
      const pane = await this.tmux.newSession({ name: tmuxSession, cwd, cols: spec.cols, rows: spec.rows, argv: plan.run ?? plan.argv });
      paneId = pane.paneId;
    }
    const insp = await inspectPath(cwd);
    const t: Tracked = {
      sessionId,
      launchId: spec.launchId ?? null,
      origin: 'managed',
      mode: spec.mode,
      tmuxSession,
      paneId,
      cwd,
      claudeSessionId: spec.claudeSessionId,
      hookToken,
      spec: { ...spec, cwd },
      hooksVersion: HOOKS_VERSION,
      hookLaunch: sdk ? null : hookLaunch,
      startedAt: new Date().toISOString(),
      transcriptPath: existing?.transcriptPath ?? null,
      hooksSeen: false,
      hookEvents: plan.hookEvents,
      permissionMode: spec.permissionMode,
      alive: true,
      pid: null,
      command: this.cfg.claudeBin,
      cols: spec.cols,
      rows: spec.rows,
      branch: insp.branch,
      repoRoot: insp.repoRoot,
      exitReason: null,
      gone: false,
    };
    this.tracked.set(sessionId, t);
    this.saveState();
    await this.openStream(t);
    const pane = (await this.tmux.listPanes()).find((p) => p.paneId === paneId);
    t.pid = pane?.panePid ?? null;
    t.alive = !!pane && !pane.dead;
    this.log('info', `started ${spec.resume ? 'resumed ' : ''}${sdk ? 'SDK-managed' : 'interactive'} Claude Code worker "${spec.displayName}" in tmux session ${tmuxSession} (${cwd})`);
    return this.report(t);
  }

  /**
   * The launch plan for an SDK-managed worker: the runner (this same program,
   * started with `managed-run`) inside the tmux pane, configured by a private
   * spec file. Permission modes and rules are the same ones an interactive
   * worker gets; nothing is bypassed.
   */
  private planManagedLaunch(spec: LaunchSpec, sessionId: string, sessionDir: string, hookToken: string, sdkEntry: string): ClaudeLaunchPlan {
    const specPath = path.join(sessionDir, 'managed.json');
    const managed: ManagedSpec = {
      sessionId,
      sdkEntry,
      claudeBin: this.cfg.claudeBin,
      cwd: spec.cwd,
      displayName: spec.displayName,
      model: spec.model,
      permissionMode: spec.permissionMode,
      allow: [...new Set([...spec.permissions.allow, ...spec.allowedTools, ...(spec.mcp ? ['mcp__orchestrator'] : [])])],
      deny: [...new Set([...spec.permissions.deny, ...spec.disallowedTools])],
      ask: spec.permissions.ask,
      strictMcp: spec.strictMcp,
      appendSystemPrompt: spec.appendSystemPrompt,
      mcp: spec.mcp,
      claudeSessionId: spec.claudeSessionId,
      resume: spec.resume,
      socketPath: this.p.socket,
      hookToken,
      approvalWaitSeconds: this.cfg.approvalWaitSeconds,
      env: { ...spec.env, ORCH_SESSION_ID: sessionId },
    };
    const unset = NESTED_SESSION_ENV.flatMap((k) => ['-u', k]);
    // When the agent itself runs on Electron's Node, the runner must too.
    const passthrough = process.env.ELECTRON_RUN_AS_NODE ? [`ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE}`] : [];
    return {
      argv: ['/usr/bin/env', ...unset, ...passthrough, ...runnerCommand(), '--spec', specPath],
      files: [{ path: specPath, content: JSON.stringify(managed, null, 2) }],
      hookEvents: MANAGED_HOOK_EVENTS,
    };
  }

  /** Hand something to an SDK-managed worker's runner. */
  private toManaged(sessionId: string, item: ManagedItem): void {
    const t = this.requireTracked(sessionId);
    if (!t.alive || t.gone) throw new Error('the worker process is not running');
    const rt = this.rt(sessionId);
    rt.inbox.push(item);
    rt.inboxWaiter?.();
  }

  /**
   * Attach to a tmux session that is already running. We add one control
   * client and nothing else: the process inside is not touched.
   */
  async attachSession(sessionId: string, tmuxSession: string, tmuxPane?: string | null): Promise<AgentSessionReport> {
    const panes = await this.tmux.listPanes();
    const candidates = panes.filter((p) => p.sessionName === tmuxSession);
    if (!candidates.length) throw new Error(`no tmux session named "${tmuxSession}" on this host`);
    const pane = tmuxPane ? candidates.find((p) => p.paneId === tmuxPane) : (candidates.find((p) => p.active && p.windowIndex === candidates[0]!.windowIndex) ?? candidates[0]);
    if (!pane) throw new Error(`pane ${tmuxPane} not found in tmux session "${tmuxSession}"`);
    for (const other of this.tracked.values()) {
      if (other.paneId === pane.paneId && other.tmuxSession === tmuxSession && !other.gone) throw new Error(`that pane is already connected (session ${other.sessionId})`);
    }
    const insp = await inspectPath(pane.currentPath || os.homedir()).catch(() => null);
    const t: Tracked = {
      sessionId,
      origin: 'attached',
      mode: 'interactive_cli',
      tmuxSession,
      paneId: pane.paneId,
      cwd: pane.currentPath,
      claudeSessionId: null,
      hookToken: null,
      spec: null,
      startedAt: new Date(pane.sessionCreated * 1000 || Date.now()).toISOString(),
      transcriptPath: null,
      hooksSeen: false,
      hookEvents: [],
      permissionMode: null,
      alive: !pane.dead,
      pid: pane.panePid,
      command: pane.currentCommand,
      cols: pane.width,
      rows: pane.height,
      branch: insp?.branch ?? null,
      repoRoot: insp?.repoRoot ?? null,
      exitReason: null,
      gone: false,
    };
    this.tracked.set(sessionId, t);
    this.saveState();
    await this.openStream(t);
    this.log('info', `attached to existing tmux session ${tmuxSession} (${pane.paneId}) without restarting it`);
    return this.report(t);
  }

  /**
   * Why a worker's process ended, in its own words when it said something: the last thing it printed
   * (for example Claude Code's "The current directory no longer exists") next to the exit status.
   */
  private async whyExited(paneId: string, status: number | null | undefined): Promise<string> {
    const base = `process exited with status ${status ?? '?'}`;
    if (!status) return base;
    try {
      const text = await this.tmux.exec(['capture-pane', '-p', '-J', '-t', paneId, '-S', '-25']);
      const said = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^Pane is dead/.test(l))
        .slice(-2)
        .join(' ')
        .slice(0, 300);
      return said ? `${base}: ${said}` : base;
    } catch {
      return base;
    }
  }

  private forget(sessionId: string): void {
    const rt = this.runtime.get(sessionId);
    rt?.stream?.close();
    if (rt?.usageTimer) clearTimeout(rt.usageTimer);
    this.runtime.delete(sessionId);
    this.tracked.delete(sessionId);
    this.saveState();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.tickCount++;
      if (!this.tracked.size) return;
      const listedAt = Date.now();
      const panes = await this.tmux.listPanes();
      for (const t of [...this.tracked.values()]) {
        // A session started while the pane list was being read is not in that list yet; judging it
        // by this snapshot would report a brand-new session as gone (e.g. stop immediately followed by start).
        if (t.origin === 'managed' && Date.parse(t.startedAt) >= listedAt) continue;
        // …and one that is being (re)started right now is about to be replaced: its launch reports the outcome.
        if (this.launching.has(t.sessionId)) continue;
        if (this.tracked.get(t.sessionId) !== t) continue;
        const pane = panes.find((p) => p.paneId === t.paneId && p.sessionName === t.tmuxSession);
        if (!pane) {
          if (!t.gone) {
            t.gone = true;
            t.alive = false;
            t.exitReason = 'tmux session ended';
            this.rt(t.sessionId).stream?.close();
            this.rt(t.sessionId).stream = null;
            this.send({ t: 'session.gone', sessionId: t.sessionId, reason: t.exitReason, launchId: t.launchId ?? null });
            this.log('info', `tmux session ${t.tmuxSession} is gone`);
            if (t.origin === 'attached') this.forget(t.sessionId);
            else this.saveState();
          }
          continue;
        }
        let changed = false;
        const alive = !pane.dead;
        if (t.gone) {
          t.gone = false;
          changed = true;
        }
        if (alive !== t.alive) {
          t.alive = alive;
          t.exitReason = alive ? null : await this.whyExited(t.paneId, pane.deadStatus);
          changed = true;
        }
        if (pane.panePid !== t.pid || pane.currentCommand !== t.command) {
          t.pid = pane.panePid;
          t.command = pane.currentCommand;
          changed = true;
        }
        if (pane.width !== t.cols || pane.height !== t.rows) {
          t.cols = pane.width;
          t.rows = pane.height;
          changed = true;
        }
        if (t.origin === 'attached' && pane.currentPath && pane.currentPath !== t.cwd) {
          t.cwd = pane.currentPath;
          changed = true;
        }
        if (this.tickCount % 4 === 0 && t.cwd) {
          const branch = await currentBranch(t.cwd).catch(() => null);
          if (branch !== t.branch) {
            t.branch = branch;
            changed = true;
          }
        }
        if (!this.rt(t.sessionId).stream && !this.rt(t.sessionId).opening) {
          await this.openStream(t).catch(() => undefined);
          changed = true;
        }
        if (changed) {
          this.send({ t: 'session', session: this.report(t) });
          this.saveState();
        }
      }
      await this.watchShells();
    } catch (e) {
      this.log('warn', `monitor tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * The commands each session is running: the shells Claude Code started for them that are still alive (see
   * `toolShells`). The office is told when the set changes — a command began or ended — and it tells the one in front
   * of the session from those that run in the background. One look at the process table for all sessions.
   */
  private async watchShells(): Promise<void> {
    if (!this.connected) return;
    const sessions = [...this.tracked.values()].filter((t) => this.shellsSent.get(t.sessionId) !== '' || (!t.gone && t.alive && t.pid));
    if (!sessions.length) return;
    const rows = sessions.some((t) => !t.gone && t.alive && t.pid) ? await readProcessTable() : new Map();
    for (const t of sessions) {
      const shells = !t.gone && t.alive && t.pid ? toolShells(rows, t.pid) : [];
      const seen = shells.map((x) => x.pid).join(',');
      if (this.shellsSent.get(t.sessionId) === seen) continue;
      this.shellsSent.set(t.sessionId, seen);
      this.send({ t: 'shells', sessionId: t.sessionId, shells: shells.slice(0, 20).map((x) => ({ pid: x.pid, command: x.command.slice(0, 4000), seconds: x.seconds })) });
    }
    for (const id of this.shellsSent.keys()) if (!this.tracked.has(id)) this.shellsSent.delete(id);
  }

  private async reportResources(): Promise<void> {
    if (!this.connected) return;
    const s = await this.sampler.sample();
    const resources: HostResources = {
      ts: new Date().toISOString(),
      cpuPercent: s.cpuPercent,
      loadAvg1: s.loadAvg1,
      memUsedBytes: s.memUsedBytes,
      memTotalBytes: s.memTotalBytes,
      sessionCount: [...this.tracked.values()].filter((t) => !t.gone && t.alive).length,
      processes: [...this.tracked.values()].filter((t) => !t.gone).map((t) => ({ sessionId: t.sessionId, pid: t.pid, alive: t.alive, command: t.command })),
    };
    this.send({ t: 'resources', resources });
  }

  private scheduleUsage(t: Tracked): void {
    if (!t.transcriptPath) return;
    const rt = this.rt(t.sessionId);
    if (rt.usageTimer) return;
    rt.usageTimer = setTimeout(() => {
      rt.usageTimer = null;
      void readTranscriptUsage(t.transcriptPath!).then((usage) => {
        if (usage) this.send({ t: 'usage', sessionId: t.sessionId, usage: rt.costUsdEstimate == null ? usage : { ...usage, costUsdEstimate: rt.costUsdEstimate } });
      });
    }, 800);
  }

  // ─────────────────────────── RPC ─────────────────────────────

  private async handleRpc(rpc: AgentRpc): Promise<unknown> {
    switch (rpc.method) {
      case 'session.create':
        return this.createSession(rpc.params.sessionId, rpc.params.spec);
      case 'session.attach': {
        // Requested by the office, not by someone at this machine: only what this host's policy allows.
        const policy = this.cfg.remoteAttach ?? 'claude';
        if (policy === 'none') throw new Error('this host does not allow the office to attach existing sessions; run `orchestrator-agent attach` on the machine itself');
        if (policy === 'claude') {
          const panes = (await this.tmux.listPanes()).filter((p) => p.sessionName === rpc.params.tmuxSession && (!rpc.params.tmuxPane || p.paneId === rpc.params.tmuxPane));
          if (panes.length && !panes.some((p) => looksLikeClaude(p))) {
            throw new Error(`"${rpc.params.tmuxSession}" is not running Claude Code. For safety the office can only attach Claude Code sessions on this host; attach other sessions from the machine itself with \`orchestrator-agent attach --tmux-session ${rpc.params.tmuxSession}\``);
          }
        }
        return this.attachSession(rpc.params.sessionId, rpc.params.tmuxSession, rpc.params.tmuxPane);
      }
      case 'session.detach':
        this.forget(rpc.params.sessionId);
        return { ok: true };
      case 'session.kill': {
        const t = this.requireTracked(rpc.params.sessionId);
        if (t.origin !== 'managed') throw new Error('refusing to kill a session Orchestrator did not start; detach it instead');
        await this.tmux.killSession(t.tmuxSession);
        void this.tick();
        return { ok: true };
      }
      case 'session.interrupt':
        if (this.tracked.get(rpc.params.sessionId)?.mode === 'managed_sdk') {
          // SDK-managed worker: the SDK's own interrupt, not a keypress.
          this.toManaged(rpc.params.sessionId, { type: 'interrupt' });
          return { ok: true, via: 'sdk' };
        }
        // Escape is Claude Code's own interrupt key: it stops the current turn without ending the process.
        await this.requireStream(rpc.params.sessionId).keys(['Escape']);
        return { ok: true, via: 'terminal' };
      case 'session.paste':
        if (this.tracked.get(rpc.params.sessionId)?.mode === 'managed_sdk' && rpc.params.submit) {
          // SDK-managed worker: the prompt is handed to the SDK as structured input.
          this.toManaged(rpc.params.sessionId, { type: 'prompt', text: rpc.params.text });
          return { ok: true, via: 'sdk' };
        }
        await this.requireStream(rpc.params.sessionId).paste(rpc.params.text, rpc.params.submit);
        return { ok: true, via: 'terminal' };
      case 'session.grant': {
        const t = this.requireTracked(rpc.params.sessionId);
        const rt = this.rt(t.sessionId);
        const now = Date.now();
        rt.grants = [...(rt.grants ?? []).filter((g) => g.until > now), { key: grantKey(rpc.params.tool, rpc.params.input), until: now + Math.max(10_000, Math.min(Number(rpc.params.ttlMs) || 0, 30 * 60_000)) }].slice(-20);
        return { ok: true };
      }
      case 'session.keys':
        await this.requireStream(rpc.params.sessionId).keys(rpc.params.keys);
        return { ok: true };
      case 'term.subscribe': {
        const t = this.requireTracked(rpc.params.sessionId);
        if (!this.rt(t.sessionId).stream) await this.openStream(t);
        const stream = this.requireStream(rpc.params.sessionId);
        // Start forwarding first, then snapshot: the viewer drops chunks with seq <= snapshot.seq.
        this.rt(t.sessionId).subscribed = true;
        const snap = await stream.snapshot();
        return { sessionId: t.sessionId, cols: snap.cols, rows: snap.rows, data: snap.data.toString('base64'), seq: snap.seq };
      }
      case 'term.unsubscribe':
        this.rt(rpc.params.sessionId).subscribed = false;
        return { ok: true };
      case 'term.input':
        await this.requireStream(rpc.params.sessionId).input(rpc.params.data);
        return { ok: true };
      case 'term.resize':
        await this.requireStream(rpc.params.sessionId).resize(rpc.params.cols, rpc.params.rows);
        return { ok: true };
      case 'term.history':
        return { text: await this.requireStream(rpc.params.sessionId).history(rpc.params.lines) };
      case 'proc.claude':
        return { processes: await this.claudeProcesses() };
      case 'tmux.discover': {
        // The office only learns about sessions it would be allowed to attach.
        const policy = this.cfg.remoteAttach ?? 'claude';
        const panes = await this.discover();
        return { panes: policy === 'any' ? panes : policy === 'none' ? panes.filter((p) => p.connectedAs) : panes.filter((p) => p.looksLikeClaude || p.connectedAs), policy };
      }
      case 'files.put':
        return this.putFile(rpc.params);
      case 'files.get':
        return this.getFile(rpc.params);
      case 'claude.accounts':
        return { accounts: (rpc.params.dirs ?? []).map((raw: string | null) => this.describeAccount(raw, rpc.params.prepare === true)) };
      case 'claude.login':
        return this.accountLogin(rpc.params);
      case 'claude.provider':
        return { account: this.setAccountProvider(rpc.params) };
      case 'fs.inspect':
        return inspectPath(this.assertAllowed(rpc.params.path));
      case 'fs.browse': {
        // Choosing a folder for an employee: only inside the folders this host was told to allow.
        const roots = this.cfg.allowedRoots.map((r) => path.resolve(r));
        const listing = await listFolders(this.assertAllowed(rpc.params.path || roots[0] || os.homedir()));
        const atRoot = roots.some((r) => realpathOfDeepestExisting(r) === listing.path);
        return { ...listing, parent: atRoot ? null : listing.parent, roots };
      }
      case 'fs.mkdir': {
        // A new folder for an employee to work in: one level, inside what this host allows — as browsing is.
        const parent = this.assertAllowed(rpc.params.parent);
        const made = await createFolder(parent, rpc.params.name);
        this.assertAllowed(made.path);
        return made;
      }
      case 'fs.docs.list':
        return listMarkdown(this.assertAllowed(rpc.params.cwd));
      case 'fs.docs.read':
        return readMarkdown(this.assertAllowed(rpc.params.cwd), rpc.params.path);
      case 'git.status':
        return gitStatus(this.assertAllowed(rpc.params.cwd));
      case 'git.diff':
        return gitDiff(this.assertAllowed(rpc.params.cwd), rpc.params.base ?? null, rpc.params.maxBytes);
      case 'git.log':
        return { commits: await gitLog(this.assertAllowed(rpc.params.cwd), rpc.params.range, rpc.params.max) };
      case 'git.worktree.ensure':
        this.assertAllowed(rpc.params.repo);
        this.assertAllowed(rpc.params.path);
        return this.gitExclusive(() => ensureWorktree(rpc.params));
      case 'git.branch.start':
        return this.gitExclusive(() => startBranch({ ...rpc.params, cwd: this.assertAllowed(rpc.params.cwd) }));
      case 'git.wip':
        return this.gitExclusive(() => commitWip({ ...rpc.params, cwd: this.assertAllowed(rpc.params.cwd) }));
      case 'git.merge':
        this.assertAllowed(rpc.params.repo);
        this.assertAllowed(rpc.params.worktree);
        return this.gitExclusive(() => mergeBranch(rpc.params));
      case 'git.integration.status':
        return integrationStatus({ ...rpc.params, repo: this.assertAllowed(rpc.params.repo) });
      case 'git.promote':
        return this.gitExclusive(() => promoteIntegration({ ...rpc.params, repo: this.assertAllowed(rpc.params.repo) }));
      case 'verify.run':
        if (!this.cfg.allowVerify) throw new Error('verification commands are disabled on this host (allowVerify=false)');
        return runVerify({ cwd: this.assertAllowed(rpc.params.cwd), command: rpc.params.command, timeoutMs: rpc.params.timeoutMs });
      case 'usage.read': {
        const t = this.requireTracked(rpc.params.sessionId);
        return { usage: t.transcriptPath ? await readTranscriptUsage(t.transcriptPath) : null };
      }
      case 'claude.headless':
        if (!this.cfg.allowHeadless) throw new Error('headless Claude runs are disabled on this host (allowHeadless=false)');
        return this.headless(this.assertAllowed(rpc.params.cwd), rpc.params.prompt, rpc.params.jsonSchema, rpc.params.timeoutMs);
      default:
        throw new Error(`unsupported rpc method ${(rpc as any).method}`);
    }
  }

  private gitChain: Promise<unknown> = Promise.resolve();

  /**
   * Orchestrator's own repository mutations (creating worktrees and branches,
   * merging) run one at a time on a host, so employees starting together can
   * never race on shared refs.
   */
  private gitExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gitChain.then(fn, fn);
    this.gitChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Claude Code processes of this user that are NOT inside a tmux pane (started in a plain SSH
   * terminal, screen, an IDE…). They cannot be taken over — there is no terminal to attach to —
   * but the office can say where they run, so their conversation can be continued in tmux.
   */
  async claudeProcesses(): Promise<Array<{ pid: number; cwd: string | null; tty: string | null; elapsed: string; command: string }>> {
    const ps = await new Promise<string>((resolve) => execFile('ps', ['-u', String(process.getuid?.() ?? ''), '-o', 'pid=,ppid=,tty=,etime=,args='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (_e, out) => resolve(out ?? '')));
    // Every tmux server of this user, not only the one the office uses: a pane anywhere means "inside tmux".
    const panePids = new Set((await this.tmux.listPanes().catch(() => [])).map((p) => p.panePid).filter(Boolean));
    const rows = new Map<number, { ppid: number; tty: string; elapsed: string; args: string }>();
    for (const line of ps.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
      if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3]!, elapsed: m[4]!, args: m[5]! });
    }
    const insideTmux = (pid: number): boolean => {
      for (let at = pid, hops = 0; at > 1 && hops < 40; hops++) {
        const row = rows.get(at);
        if (panePids.has(at) || (row && /(^|\/)tmux(: server)?(\s|$)/.test(row.args))) return true;
        if (!row) return false;
        at = row.ppid;
      }
      return false;
    };
    const out: Array<{ pid: number; cwd: string | null; tty: string | null; elapsed: string; command: string }> = [];
    for (const [pid, row] of rows) {
      const exe = row.args.split(/\s+/)[0] ?? '';
      // The CLI itself: `claude …`, or node running its entry file. Not one-shot `claude -p` runs and not this agent.
      if (!/(^|\/)claude(\.exe)?$/.test(exe) && !/claude-code\/(cli\.js|bin\/claude)/.test(row.args) && !/^(\S*\/)?node\s+(\S*\/)?claude(\s|$)/.test(row.args)) continue;
      if (/\s(-p|--print)(\s|$)/.test(row.args) || /orchestrator-agent/.test(row.args)) continue;
      // Its own helpers have a claude parent: report the top one only.
      const parent = rows.get(row.ppid);
      if (parent && (/(^|\/)claude(\.exe)?(\s|$)/.test(parent.args) || /claude-code\/(cli\.js|bin\/claude)/.test(parent.args))) continue;
      if (insideTmux(pid)) continue;
      let cwd: string | null = null;
      try {
        cwd = process.platform === 'linux' ? fs.readlinkSync(`/proc/${pid}/cwd`) : await new Promise<string | null>((resolve) => execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }, (_e, o) => resolve(/^n(.+)$/m.exec(o ?? '')?.[1] ?? null)));
      } catch {
        cwd = null;
      }
      out.push({ pid, cwd, tty: row.tty === '?' || row.tty === '??' ? null : row.tty, elapsed: row.elapsed, command: redactSecrets(row.args).slice(0, 200) });
    }
    return out;
  }

  async discover(): Promise<Array<Record<string, unknown>>> {
    const panes = await this.tmux.listPanes();
    return panes.map((p) => {
      const tracked = [...this.tracked.values()].find((t) => t.paneId === p.paneId && t.tmuxSession === p.sessionName && !t.gone);
      return {
        tmuxSession: p.sessionName,
        paneId: p.paneId,
        window: p.windowIndex,
        command: p.currentCommand,
        cwd: p.currentPath,
        size: `${p.width}x${p.height}`,
        dead: p.dead,
        looksLikeClaude: looksLikeClaude(p),
        connectedAs: tracked?.sessionId ?? null,
      };
    });
  }

  private headless(cwd: string, prompt: string, jsonSchema: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const env: Record<string, string | undefined> = { ...process.env };
      for (const k of NESTED_SESSION_ENV) delete env[k];
      const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan', '--strict-mcp-config'];
      if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));
      execFile(this.cfg.claudeBin, args, { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
        if (err) return reject(new Error(`headless claude failed: ${err.message}`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('headless claude returned non-JSON output'));
        }
      });
    });
  }

  // ───────────────────────── hook receiver ─────────────────────

  private startHookServer(): Promise<void> {
    try {
      fs.unlinkSync(this.p.socket);
    } catch {
      /* no stale socket */
    }
    const server = http.createServer((req, res) => {
      void this.onHttp(req, res).catch((e) => {
        this.log('warn', `hook handler: ${e?.message ?? e}`);
        if (!res.headersSent) res.writeHead(200);
        res.end();
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 0;
    server.timeout = 0;
    this.hookServer = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.p.socket, () => {
        try {
          fs.chmodSync(this.p.socket, 0o600);
        } catch {
          /* best effort */
        }
        resolve();
      });
    });
  }

  private readBody(req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://orchestrator');
    if (url.pathname === '/hook' && req.method === 'POST') return this.onHook(req, res);
    if (url.pathname === '/statusline' && req.method === 'POST') return this.onStatusLine(req, res);
    if (url.pathname.startsWith('/managed/')) return this.onManaged(url, req, res);
    if (url.pathname.startsWith('/control/')) return this.onControl(url, req, res);
    res.writeHead(404);
    res.end();
  }

  /** Endpoints used by an SDK-managed worker's runner, authenticated with that session's own token. */
  private async onManaged(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const t = this.tracked.get(String(req.headers['x-orch-session'] ?? ''));
    if (!t?.hookToken || t.mode !== 'managed_sdk' || !safeEqual(String(req.headers['x-orch-token'] ?? ''), t.hookToken)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const rt = this.rt(t.sessionId);
    if (url.pathname === '/managed/inbox' && req.method === 'GET') {
      if (!rt.inbox.length) {
        const waitMs = Math.min(60, Math.max(1, Number(url.searchParams.get('wait')) || 25)) * 1000;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            if (rt.inboxWaiter === done) rt.inboxWaiter = null;
            resolve();
          };
          const timer = setTimeout(done, waitMs);
          rt.inboxWaiter = done;
          res.on('close', done);
        });
      }
      if (res.destroyed) return;
      const item = rt.inbox.shift();
      res.writeHead(item ? 200 : 204, { 'content-type': 'application/json' });
      res.end(item ? JSON.stringify(item) : undefined);
      return;
    }
    if (url.pathname === '/managed/usage' && req.method === 'POST') {
      const body = JSON.parse((await this.readBody(req, 64 * 1024)) || '{}');
      if (typeof body.costUsdEstimate === 'number' && Number.isFinite(body.costUsdEstimate)) rt.costUsdEstimate = body.costUsdEstimate;
      this.scheduleUsage(t);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  }

  private isBlocking(payload: HookPayload): boolean {
    const ev = payload.hook_event_name;
    return ev === 'PermissionRequest' || ev === 'Stop' || (ev === 'PreToolUse' && payload.tool_name === 'AskUserQuestion');
  }

  /**
   * Host-side policy gate: a command matching a project's high-risk patterns is
   * escalated to "ask", which forces Claude Code's own permission flow (and so
   * the owner's approval) no matter how permissive the session's mode is.
   */
  private localPolicy(t: Tracked, payload: HookPayload): Record<string, unknown> | null {
    if (payload.hook_event_name !== 'PreToolUse') return null;
    // The owner allowed exactly this call, once, after Claude Code had refused it: it is let through — and the grant is used up.
    const rt = this.runtime.get(t.sessionId);
    if (rt?.grants?.length) {
      const key = grantKey(String(payload.tool_name ?? ''), payload.tool_input);
      const i = rt.grants.findIndex((g) => g.key === key && g.until > Date.now());
      if (i >= 0) {
        rt.grants.splice(i, 1);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Allowed once by the owner of the office, for exactly this call.' }, orchGranted: true };
      }
    }
    // The office's own files on this machine — other sessions' folders (each holds that session's token for the
    // office's tools: the foreman's among them), this agent's records, and the office's data where it runs here (its
    // owner token, the vault's key). Every session runs as the same user and could open them; none has a reason to.
    const reach = this.officeFiles(t);
    const named = ['file_path', 'path', 'notebook_path'].map((k) => payload.tool_input?.[k]).find((v): v is string => typeof v === 'string' && !!v);
    if (payload.tool_name !== 'Bash' && named && reach.holds(named, payload.cwd ?? t.cwd)) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: "Orchestrator policy: that is one of the office's own files on this machine (another session's folder, the agent's records, or the office's data). It is not part of anybody's work; leave it alone." } };
    }
    if (payload.tool_name !== 'Bash') return null;
    const command = String(payload.tool_input?.command ?? '');
    if (reach.mentioned(command)) {
      if (t.spec?.permissionMode === 'bypassPermissions') return { orchHold: true, fence: true, pattern: "the office's own files on this machine" };
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: "Orchestrator policy: this command names the office's own files on this machine (another session's folder, the agent's records, or the office's data) and needs the owner's approval." } };
    }
    for (const pattern of t.spec?.highRiskPatterns ?? []) {
      try {
        if (new RegExp(pattern, 'i').test(command)) {
          // In bypass mode Claude Code asks nobody, so "ask" would mean nothing there: the call is held here until
          // the owner has answered in the office (see the hook handler), and refused if no answer comes.
          if (t.spec?.permissionMode === 'bypassPermissions') return { orchHold: true, pattern };
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: `Orchestrator policy: this command matches a high-risk pattern (${pattern}) and needs the owner's approval.`,
            },
          };
        }
      } catch {
        /* invalid pattern: ignore rather than block all work */
      }
    }
    return null;
  }

  /**
   * Which paths on this machine are the office's own, for one session: this agent's home except the files the office
   * put there for employees and the session's own folder, and the office's data folder when the office runs here.
   * `holds`: is this path one of them (symlinks resolved)? `mentioned`: does a command name one?
   */
  private officeFiles(t: Tracked): { holds: (file: string, cwd: string) => boolean; mentioned: (command: string) => boolean } {
    const home = path.dirname(this.p.sessions);
    const real = (p: string) => realpathOfDeepestExisting(path.resolve(p));
    const mine = [real(this.filesRoot()), real(path.join(this.p.sessions, t.sessionId))];
    const servers = [process.env.ORCH_SERVER_HOME, path.join(os.homedir(), '.orchestrator', 'server'), path.join(path.dirname(home), 'server')].filter((d): d is string => !!d && fs.existsSync(path.join(d, 'owner-token')));
    const closed = [real(home), ...servers.map(real)];
    /** The same places as somebody would write them, a link in their path or not. */
    const written = [...new Set([...closed, path.resolve(home), ...servers.map((d) => path.resolve(d))])];
    const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);
    const holds = (file: string, cwd: string): boolean => {
      let p: string;
      try {
        const expanded = file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
        p = real(path.isAbsolute(expanded) ? expanded : path.join(cwd || os.homedir(), expanded));
      } catch {
        return false;
      }
      return closed.some((root) => inside(p, root)) && !mine.some((root) => inside(p, root));
    };
    // In a command: any word that is such a path, written out in full or from the home folder (`~/…`, `$HOME/…`).
    // A path put together by the command itself is not seen — this is a fence at the obvious way in, not a wall.
    //
    // Every word costs look-ups on the disk, on the agent's one thread, and the command is the session's to shape:
    // so a word longer than any path is not looked up, a word is looked up once, and the look-ups have a budget.
    // Words that name one of those places as they are written come first and are all looked at, whatever else the
    // command holds (padding does not get a plain path past the fence); the rest — which could only lead there
    // through a link — as far as the budget goes.
    const mentioned = (command: string): boolean => {
      const homeDir = os.homedir();
      const words = [...new Set(command.replace(/\$\{?HOME\}?/g, homeDir).split(/[\s"'`;|&<>()=]+/).filter((w) => w.includes('/') && w.length <= PATH_LONGEST))];
      const asWritten = (w: string): boolean => {
        const expanded = w.startsWith('~/') ? path.join(homeDir, w.slice(2)) : w;
        const abs = path.resolve(path.isAbsolute(expanded) ? expanded : path.join(t.cwd || homeDir, expanded));
        return written.some((root) => inside(abs, root));
      };
      const plain = words.filter(asWritten);
      let budget = FENCE_LOOKUPS;
      for (const w of plain) {
        // More such paths than are worth following one by one: the command is all about the office's folders.
        if ((budget -= w.split('/').length) < 0) return true;
        if (holds(w, t.cwd)) return true;
      }
      const set = new Set(plain);
      for (const w of words) {
        if (set.has(w)) continue;
        if ((budget -= w.split('/').length) < 0) return false;
        if (holds(w, t.cwd)) return true;
      }
      return false;
    };
    return { holds, mentioned };
  }

  private lastLimits = new Map<string, string>();
  private limitNames = new Set<string>();

  /**
   * Claude Code's status line input for one of our sessions. Only the account's rate limits are
   * taken from it; together with who is logged in (read from Claude Code's own config file in the
   * session's config folder) they are passed to the office. Nothing else is kept.
   */
  private async onStatusLine(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const tracked = this.tracked.get(String(req.headers['x-orch-session'] ?? ''));
    const body = await this.readBody(req);
    res.writeHead(tracked?.hookToken && safeEqual(String(req.headers['x-orch-token'] ?? ''), tracked.hookToken) ? 200 : 403);
    res.end();
    if (res.statusCode !== 200 || !tracked) return;
    let input: any;
    try {
      input = JSON.parse(body);
    } catch {
      return;
    }
    const win = (w: any) => (w && typeof w.used_percentage === 'number' ? { usedPercent: Math.max(0, Math.min(100, w.used_percentage)), resetsAt: typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000).toISOString() : null } : null);
    const fiveHour = win(input?.rate_limits?.five_hour);
    const sevenDay = win(input?.rate_limits?.seven_day);
    // Whatever other windows it gives — a model's own week, where Claude Code reports one — are passed on under
    // their own names: the office knows what to make of `seven_day_<model>`, and keeps the rest out of the way.
    const windows: Record<string, { usedPercent: number; resetsAt: string | null }> = {};
    for (const [name, value] of Object.entries(input?.rate_limits && typeof input.rate_limits === 'object' ? (input.rate_limits as Record<string, unknown>) : {})) {
      if (name === 'five_hour' || name === 'seven_day' || !/^[a-z0-9_]{1,40}$/.test(name)) continue;
      const w = win(value);
      if (w) windows[name] = w;
    }
    const names = Object.keys(input?.rate_limits && typeof input.rate_limits === 'object' ? input.rate_limits : {}).sort().join(', ');
    if (names && !this.limitNames.has(names)) {
      // Said once for each set of windows seen: which windows this Claude Code reports at all.
      this.limitNames.add(names);
      this.log('info', `Claude Code reports these limit windows: ${names}`);
    }
    if (!fiveHour && !sevenDay && !Object.keys(windows).length) return; // not a subscription account, or no answer yet in this session
    const who = this.claudeAccount(tracked.spec?.env?.CLAUDE_CONFIG_DIR || null);
    const msg = { t: 'limits' as const, sessionId: tracked.sessionId, configDir: tracked.spec?.env?.ORCH_CLAUDE_ACCOUNT || null, email: who.email, organization: who.organization, fiveHour, sevenDay, ...(Object.keys(windows).length ? { windows } : {}) };
    // The same figures again are not news.
    const key = JSON.stringify([msg.fiveHour, msg.sevenDay, msg.email, windows]);
    if (this.lastLimits.get(tracked.sessionId) === key) return;
    this.lastLimits.set(tracked.sessionId, key);
    this.send(msg);
  }

  /** Where the files attached to tasks stand on this machine: a folder of the agent's own, outside every repository. */
  private filesRoot(): string {
    return path.join(path.dirname(this.p.sessions), 'files');
  }

  /** The browser employees here can drive, if one is installed (beside the office program, or in this agent's home). */
  private browserMcp(): ReturnType<typeof findBrowserMcp> {
    const entry = process.argv[1] ? path.dirname(fs.realpathSync(process.argv[1])) : process.cwd();
    // The agent's bundle is at <install>/app/apps/host-agent/dist: the browser is installed beside `app`, where an update does not touch it.
    return findBrowserMcp([path.resolve(entry, '..', '..', '..', '..'), path.resolve(entry, '..', '..', '..'), path.dirname(this.p.sessions), path.join(os.homedir(), '.orchestrator')]);
  }

  /** A piece of a task's attachment arrives. One folder per task; the name was made safe by the office and is checked again here. */
  private putFile(p: { folder: string; name: string; offset: number; dataBase64: string; last: boolean }): { path: string; size: number } {
    // (Letters and digits of any alphabet stay: two names that differ only in such letters must stay two files.)
    const clean = (x: string) => String(x ?? '').normalize('NFC').replace(/[^\p{L}\p{N}._ ()@+-]/gu, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
    const dir = path.join(this.filesRoot(), clean(p.folder));
    const file = path.join(dir, clean(p.name));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const data = Buffer.from(String(p.dataBase64 ?? ''), 'base64');
    if (p.offset === 0) fs.writeFileSync(file, data, { mode: 0o600 });
    else {
      if (!fs.existsSync(file) || fs.statSync(file).size !== p.offset) throw new Error(`the next piece of ${p.name} does not follow what is here`);
      fs.appendFileSync(file, data);
    }
    return { path: file, size: fs.statSync(file).size };
  }

  /**
   * A piece of a file an employee names as evidence. Only a regular file, and only from where this agent may look:
   * its allowed roots, its own folders (a session's browser shots, attachments) and the machine's temp folder.
   */
  private getFile(p: { path: string; cwd?: string | null; sessionId?: string | null; offset: number; length: number }): { dataBase64: string; size: number; name: string } {
    const raw = String(p.path ?? '').trim();
    if (!raw) throw new Error('no file was named');
    const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
    const abs = path.resolve(p.cwd && !path.isAbsolute(expanded) ? p.cwd : os.homedir(), expanded);
    if (!fs.existsSync(abs)) throw new Error(`there is no file at ${abs}`);
    const real = fs.realpathSync(abs);
    if (fs.statSync(real).isDirectory()) throw new Error(`${abs} is not a file`);
    // Where an employee's evidence comes from: the folder it works in, the folder its browser saves to, the files
    // the office itself put on this machine for it, and temporary folders. Not "anywhere this machine lets the office
    // work": that is usually the whole home folder, with keys and the office's own data in it — and what is attached
    // here can be opened by everyone who sees the task. The agent reads the file itself, so none of Claude Code's
    // own checks stand in front of this.
    const tracked = p.sessionId ? this.tracked.get(p.sessionId) : undefined;
    // A working folder the office names counts only if it is a folder, and one this machine lets the office work in
    // (the office is somebody else's machine on a member's computer: "the folder is this very file" must not be a
    // way around what follows).
    const folder = (dir: string | null | undefined, mustBeAllowed: boolean): string | null => {
      if (typeof dir !== 'string' || !dir) return null;
      try {
        const r = realpathOfDeepestExisting(path.resolve(mustBeAllowed ? this.assertAllowed(dir) : dir));
        return fs.existsSync(r) && fs.statSync(r).isDirectory() ? r : null;
      } catch {
        return null;
      }
    };
    const bases = [folder(p.cwd, true), folder(tracked?.cwd, false), folder(tracked?.repoRoot, false), tracked ? folder(path.join(this.p.sessions, tracked.sessionId, 'browser'), false) : null, folder(this.filesRoot(), false), folder(os.tmpdir(), false), folder('/tmp', false)].filter((x): x is string => !!x);
    const base = bases.filter((r) => real.startsWith(r + path.sep)).sort((x, y) => y.length - x.length)[0];
    const where = [p.cwd ?? tracked?.cwd, 'the folder your browser saves to', 'a temporary folder'].filter(Boolean).join(', ');
    if (!base) {
      throw new Error(`${abs} cannot be attached from there. A file is taken from your working folder (${where}); if this is something to show, save or copy it there first.`);
    }
    // Nothing hidden (a `.git`, a `.env`, a `.ssh`, a `.netrc`), and nothing that is a key or a credential by its name.
    const below = real.slice(base.length + 1).split(path.sep);
    if (below.some((part) => part.startsWith('.'))) throw new Error(`${abs} is a hidden file or in a hidden folder; those are not attached to tasks`);
    if (/(^|\/)(id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(pem|key|p12|pfx|kdbx|keystore)|owner-token|vault\.key|[^/]*credentials[^/]*|netrc|config\.json|mcp\.json|settings\.json|managed\.json|state\.json|outbox\.json|vault(\.mjs)?)$/i.test(real)) throw new Error(`${path.basename(real)} looks like a key or a credential; those are not attached to tasks`);
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error(`${abs} is not a file`);
    const length = Math.max(0, Math.min(Number(p.length) || 0, 2 * 1024 * 1024, st.size - (Number(p.offset) || 0)));
    const buf = Buffer.alloc(length);
    if (length) {
      const fd = fs.openSync(real, 'r');
      try {
        fs.readSync(fd, buf, 0, length, Number(p.offset) || 0);
      } finally {
        fs.closeSync(fd);
      }
    }
    return { dataBase64: buf.toString('base64'), size: st.size, name: path.basename(real) };
  }

  /** A Claude config folder as the owner wrote it (`~/.claude-2`) → where it is on this machine. Only inside this user's home. */
  private accountDir(raw: string): string {
    const dir = path.resolve(raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
    if (dir === os.homedir() || !dir.startsWith(os.homedir() + path.sep)) throw new Error(`the Claude account folder must be inside your home folder on this machine (${dir})`);
    return dir;
  }

  /**
   * One Claude account of this machine: is its folder there, is anybody logged in, who. With `prepare`, a folder
   * that does not exist yet is made, and its conversations are the default account's (a link to the same `projects`
   * folder) — so an employee moved from one account to another goes on with the conversation they had.
   */
  private describeAccount(raw: string | null, prepare: boolean): AccountInfo {
    const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    if (!raw) {
      const who = this.claudeAccount(null);
      const other = this.accountProvider(base);
      if (other) return { dir: null, path: base, exists: true, loggedIn: other.hasKey, email: null, organization: null, provider: other.provider, endpoint: other.endpoint, login: '' };
      return { dir: null, path: base, exists: true, loggedIn: !!who.email || fs.existsSync(path.join(os.homedir(), '.claude.json')), ...who, provider: 'anthropic', login: `${this.cfg.claudeBin}   (then /login)` };
    }
    let dir: string;
    try {
      dir = this.accountDir(raw);
    } catch (e) {
      return { dir: raw, path: raw, exists: false, loggedIn: false, email: null, organization: null, login: '', error: (e as Error).message };
    }
    const login = `CLAUDE_CONFIG_DIR=${dir} ${this.cfg.claudeBin}   (then /login)`;
    try {
      if (prepare) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const projects = path.join(dir, 'projects');
        const shared = path.join(base, 'projects');
        if (!fs.existsSync(projects) && dir !== base) {
          fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
          fs.symlinkSync(shared, projects, 'dir');
        }
      }
    } catch (e) {
      return { dir: raw, path: dir, exists: fs.existsSync(dir), loggedIn: false, email: null, organization: null, login, error: (e as Error).message };
    }
    const other = this.accountProvider(dir);
    if (other) return { dir: raw, path: dir, exists: true, loggedIn: other.hasKey, email: null, organization: null, provider: other.provider, endpoint: other.endpoint, login: '' };
    const who = this.claudeAccount(dir);
    return { dir: raw, path: dir, exists: fs.existsSync(dir), loggedIn: fs.existsSync(path.join(dir, '.claude.json')) && !!who.email, ...who, provider: 'anthropic', login };
  }

  /**
   * Does this config folder send Claude Code to another service than Anthropic's? Read from the folder's own
   * `settings.json` (`env.ANTHROPIC_BASE_URL`). Says which service and whether a key is set — never the key.
   */
  private accountProvider(configDir: string): { provider: 'zai' | 'custom'; endpoint: string | null; hasKey: boolean } | null {
    try {
      const env = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'))?.env;
      const url = typeof env?.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.trim() : '';
      if (!url) return null;
      let endpoint: string | null = null;
      try {
        endpoint = new URL(url).hostname;
      } catch {
        /* not an address: said as it is not */
      }
      return { provider: endpoint && /(^|\.)z\.ai$/.test(endpoint) ? 'zai' : 'custom', endpoint, hasKey: !!String(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? '').trim() };
    } catch {
      return null;
    }
  }

  /**
   * Make a config folder an account of another service that speaks Claude Code's protocol (Z.AI's GLM Coding Plan):
   * the service's address and the key go into the folder's own `settings.json` (`env`), readable by this user only.
   * Claude Code started with `CLAUDE_CONFIG_DIR` at that folder then talks to that service; nobody signs in.
   * The folder is marked as set up (`hasCompletedOnboarding`), so that the first session does not stop at the
   * first-run screens. What was in the folder's settings stays; only these keys are written.
   */
  private setAccountProvider(p: { dir: string; provider: 'zai' | 'custom'; token: string; baseUrl?: string; models?: { opus?: string; sonnet?: string; haiku?: string } }): AccountInfo {
    const token = String(p.token ?? '').trim();
    if (!token || /\s/.test(token) || token.length > 512) throw new Error('that does not look like an API key');
    const baseUrl = p.provider === 'zai' ? ZAI_BASE_URL : String(p.baseUrl ?? '').trim();
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error('the address of the service is not a web address');
    }
    if (url.protocol !== 'https:') throw new Error('the address of the service must begin with https://');
    const prepared = this.describeAccount(p.dir, true);
    if (prepared.error) throw new Error(prepared.error);
    const dir = this.accountDir(p.dir);
    const file = path.join(dir, 'settings.json');
    let settings: Record<string, any> = {};
    try {
      const had = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (had && typeof had === 'object' && !Array.isArray(had)) settings = had;
    } catch {
      /* none yet */
    }
    const env: Record<string, unknown> = { ...(settings.env && typeof settings.env === 'object' ? settings.env : {}) };
    env.ANTHROPIC_BASE_URL = url.toString().replace(/\/$/, '');
    env.ANTHROPIC_AUTH_TOKEN = token;
    delete env.ANTHROPIC_API_KEY;
    // The services answer more slowly than Anthropic's; their own instructions set this.
    env.API_TIMEOUT_MS ??= '3000000';
    for (const [key, name] of [['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'], ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']] as const) {
      const model = String(p.models?.[key] ?? '').trim();
      if (model && /^[A-Za-z0-9._:\[\]\/-]{1,80}$/.test(model)) env[name] = model;
      else if (p.models && key in p.models) delete env[name];
    }
    settings.env = env;
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const state = path.join(dir, '.claude.json');
    let own: Record<string, any> = {};
    try {
      const had = JSON.parse(fs.readFileSync(state, 'utf8'));
      if (had && typeof had === 'object' && !Array.isArray(had)) own = had;
    } catch {
      /* none yet */
    }
    if (own.hasCompletedOnboarding !== true) {
      own.hasCompletedOnboarding = true;
      fs.writeFileSync(state, JSON.stringify(own, null, 2) + '\n', { mode: 0o600 });
    }
    return this.describeAccount(p.dir, false);
  }

  /** Sign-ins in progress: the tmux session of each, by config folder, and when it was started. */
  private logins = new Map<string, { name: string; pane: string; at: number }>();
  /** Does this Claude Code have `claude auth login`? Asked once (its help says so). */
  private authLogin: boolean | null = null;

  /**
   * Signing in to a Claude account from the office. Claude Code's own sign-in runs in a terminal of its own on this
   * machine (a tmux server apart from the one employees work in, so it is never taken for a session); the office
   * shows what that terminal shows and types into it what the person at the office types: it prints a link, the
   * person opens it in their own browser and signs in, and pastes the code the page gives back here. Nothing of
   * the sign-in is read or kept by the agent beyond that terminal's text; the login itself is Claude Code's.
   */
  private async accountLogin(p: { op: 'start' | 'screen' | 'input' | 'stop'; dir: string | null; text?: string; key?: string; email?: string }): Promise<AccountLogin> {
    const key = p.dir ?? 'default';
    // A sign-in nobody finished is not left standing.
    for (const [k, l] of this.logins) if (Date.now() - l.at > 30 * 60_000) (await this.loginTmux.killSession(l.name), this.logins.delete(k));
    let cur = this.logins.get(key);
    if (p.op === 'start') {
      const account = this.describeAccount(p.dir, true);
      if (account.error) throw new Error(account.error);
      if (cur) await this.loginTmux.killSession(cur.name);
      if (this.authLogin === null) this.authLogin = await hasAuthLogin(this.cfg.claudeBin);
      const email = String(p.email ?? '').trim();
      // `claude auth login` is the sign-in and nothing else. A Claude Code without it is started as it is: in a folder
      // nobody is signed in to, it begins with the sign-in by itself (and `/login` typed there starts it otherwise).
      const argv = this.authLogin ? [this.cfg.claudeBin, 'auth', 'login', ...(/^[^\s@]+@[^\s@]+$/.test(email) ? ['--email', email] : [])] : [this.cfg.claudeBin];
      const name = `orch-login-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
      await this.loginTmux.killSession(name);
      // (Wide, so that the long address of the sign-in page is printed in one piece.)
      const pane = await this.loginTmux.newSession({ name, cwd: os.homedir(), cols: 420, rows: 32, argv, env: p.dir ? { CLAUDE_CONFIG_DIR: account.path } : {} });
      cur = { name, pane: pane.paneId, at: Date.now() };
      this.logins.set(key, cur);
    } else if (p.op === 'input' && cur) {
      const text = String(p.text ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 4096);
      if (text) await this.loginTmux.sendKeys(cur.pane, ['-l', '--', text]);
      const named = LOGIN_KEYS[String(p.key ?? '')];
      if (named) await this.loginTmux.sendKeys(cur.pane, [named]);
    } else if (p.op === 'stop' && cur) {
      await this.loginTmux.killSession(cur.name);
      this.logins.delete(key);
      cur = undefined;
    }
    let lines: string[] = [];
    let running = false;
    if (cur) {
      try {
        const text = await this.loginTmux.exec(['capture-pane', '-p', '-J', '-t', cur.pane, '-S', '-200']);
        lines = text.replace(/\s+$/, '').split('\n').map((l) => l.replace(/\s+$/, '')).slice(-80);
        running = (await this.loginTmux.exec(['display-message', '-p', '-t', cur.pane, '#{pane_dead}'])).trim() !== '1';
      } catch {
        // The terminal is gone (the tmux server was stopped): the sign-in is over.
        this.logins.delete(key);
      }
    }
    return { dir: p.dir, running, lines, account: this.describeAccount(p.dir, false) };
  }

  /** Who is logged in to Claude Code in this config folder (or the default one), from its own config file. */
  private claudeAccount(configDir: string | null): { email: string | null; organization: string | null } {
    for (const file of configDir ? [path.join(configDir, '.claude.json')] : [path.join(process.env.CLAUDE_CONFIG_DIR ?? os.homedir(), '.claude.json'), path.join(os.homedir(), '.claude.json')]) {
      try {
        const account = JSON.parse(fs.readFileSync(file, 'utf8'))?.oauthAccount;
        if (account) return { email: typeof account.emailAddress === 'string' ? account.emailAddress : null, organization: typeof account.organizationName === 'string' ? account.organizationName : null };
      } catch {
        /* not there, or not readable */
      }
    }
    return { email: null, organization: null };
  }

  private async onHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = String(req.headers['x-orch-token'] ?? '');
    const sid = String(req.headers['x-orch-session'] ?? '') || null;
    const pane = String(req.headers['x-tmux-pane'] ?? '') || null;
    const body = await this.readBody(req);
    let tracked = sid ? this.tracked.get(sid) : undefined;
    if (!tracked && pane) tracked = [...this.tracked.values()].find((t) => t.paneId === pane && !t.gone);
    const authorized = tracked?.hookToken ? safeEqual(token, tracked.hookToken) : safeEqual(token, this.cfg.localToken);
    if (!authorized) {
      res.writeHead(403);
      res.end();
      return;
    }
    // The last words of a process that was replaced: the session was started again since, and this hook belongs to
    // the start before. It says nothing about the process that runs now — not that it is alive, not that it is
    // between turns — and it gets no answer.
    // (A hook that names no start at all is one too, when the running process was given a name: it comes from a
    // process started before starts had names.)
    const launch = String(req.headers['x-orch-launch'] ?? '');
    if (tracked?.hookLaunch && launch !== tracked.hookLaunch) {
      res.writeHead(200);
      res.end();
      return;
    }
    let payload: HookPayload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(200);
      res.end();
      return;
    }
    if (!tracked || typeof payload?.hook_event_name !== 'string') {
      // A hook from a session we are not tracking: nothing to attribute it to.
      res.writeHead(200);
      res.end();
      return;
    }
    let reportChanged = false;
    if (!tracked.hooksSeen) {
      tracked.hooksSeen = true;
      reportChanged = true;
    }
    if (payload.transcript_path && payload.transcript_path !== tracked.transcriptPath) {
      tracked.transcriptPath = payload.transcript_path;
      reportChanged = true;
    }
    if (payload.session_id && payload.session_id !== tracked.claudeSessionId) {
      tracked.claudeSessionId = payload.session_id;
      reportChanged = true;
    }
    if (payload.permission_mode && payload.permission_mode !== tracked.permissionMode) {
      tracked.permissionMode = payload.permission_mode;
      reportChanged = true;
    }
    if (reportChanged) {
      this.send({ t: 'session', session: this.report(tracked) });
      this.saveState();
    }
    if (payload.hook_event_name === 'Stop' || payload.hook_event_name === 'SessionEnd') this.scheduleUsage(tracked);
    // What the agent wrote before this tool — the sentence one reads in the terminal above it — goes with the hook,
    // for the line of a conversation that says what they are doing (one small read of the end of the transcript).
    if (payload.hook_event_name === 'PreToolUse' && tracked.transcriptPath) {
      const said = await readLastSaid(tracked.transcriptPath);
      if (said) payload = { ...payload, orch_said: said };
    }

    // A hook that tries again after this agent was restarted comes under the same name: the event keeps its id, so
    // the office knows it for the request it is already asking about.
    const named = /^[0-9]{1,10}-[0-9]{9,11}$/.test(String(req.headers['x-orch-hook'] ?? '')) ? String(req.headers['x-orch-hook']) : null;
    const hex = named ? crypto.createHash('sha256').update(`${tracked.sessionId}|${named}|${payload.hook_event_name}`).digest('hex') : '';
    const left = Number(req.headers['x-orch-left']);
    const event: RawHookEvent = {
      id: named ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` : crypto.randomUUID(),
      ts: new Date().toISOString(),
      hostSeq: ++this.hostSeq,
      sessionId: tracked.sessionId,
      tmuxPane: pane ?? tracked.paneId,
      payload,
    };

    let local = this.localPolicy(tracked, payload);
    // Bypass mode and a high-risk command: wait for the owner's decision; without one, the call is refused.
    let held: string | null = null;
    if (local?.orchHold) {
      held = String(local.pattern ?? '');
      // Which of the two it is held for: the office's own files (always the owner's to decide), or the high-risk
      // list (which the owner may have switched off for this level since the session was started).
      payload = { ...payload, orch_policy: 'high_risk_held', orch_held_for: local.fence === true ? 'office_files' : 'pattern' };
      local = null;
    }
    if (local) {
      const granted = local.orchGranted === true;
      delete local.orchGranted;
      event.payload = { ...payload, orch_policy: granted ? 'granted_once' : 'high_risk' };
      this.enqueue(event);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(local));
      return;
    }

    if (held !== null) event.payload = payload;
    const refuse = (why: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Orchestrator policy: this command matches a high-risk pattern (${held}) and needs the owner's approval. ${why} Do not try it another way: wait, or ask the boss (ask_boss).` } });
    // The office went away a moment ago and may be back in a moment (a restart): a request for a decision waits for it.
    const waitsForOffice = !this.connected && !!this.linkGrace && payload.hook_event_name !== 'Stop';
    if (held !== null && !this.connected && !waitsForOffice) {
      this.enqueue(event);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(refuse('The office cannot be reached right now, so nobody could be asked.'));
      return;
    }
    if (held === null && (!this.isBlocking(payload) || (!this.connected && !waitsForOffice))) {
      this.enqueue(event);
      res.writeHead(200);
      res.end();
      return;
    }

    // Blocking hook: hold the request open while the server (and possibly the owner) decides.
    const requestId = crypto.randomUUID();
    // Not longer than the hook itself still waits (it says how long): the answer "nobody answered" must come from
    // here, not from a hook that ran out of time and said nothing.
    const waitMs = payload.hook_event_name === 'Stop' ? 5000 : Math.max(1, Math.min(this.cfg.approvalWaitSeconds, Number.isFinite(left) && left > 0 ? left - 4 : Infinity)) * 1000;
    let finished = false;
    const output = await new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHooks.delete(requestId);
        resolve(null);
      }, waitMs);
      this.pendingHooks.set(requestId, { resolve, timer, event, keep: payload.hook_event_name !== 'Stop' });
      res.on('close', () => {
        // (When this agent is being stopped the hook is not over: it tries again, and the next agent takes it up.)
        if (finished || this.stopping) return;
        // Claude Code gave up on the hook (timeout, interrupt, session ended).
        const pending = this.pendingHooks.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingHooks.delete(requestId);
          this.send({ t: 'hook.settled', requestId, outcome: 'abandoned', detail: 'hook connection closed before a decision' });
          pending.resolve(null);
        }
      });
      // (While the office is away for a moment it is not sent now: it goes out when the office is back.)
      if (!waitsForOffice && !this.send({ t: 'hook.request', requestId, event })) {
        clearTimeout(timer);
        this.pendingHooks.delete(requestId);
        this.enqueue(event);
        resolve(null);
      }
    });
    finished = true;
    if (res.destroyed || res.writableEnded) return;
    if (output) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(output), () => this.send({ t: 'hook.settled', requestId, outcome: 'delivered' }));
    } else if (held !== null) {
      // Nobody answered in time, and in bypass mode there is no prompt to fall back to: refused, in so many words.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(refuse('The owner has not answered yet.'), () => this.send({ t: 'hook.settled', requestId, outcome: 'abandoned', detail: 'no decision in time; the command was refused' }));
    } else {
      res.writeHead(200);
      res.end(() => this.send({ t: 'hook.settled', requestId, outcome: 'abandoned', detail: 'no decision in time; Claude Code falls back to its own prompt' }));
    }
  }

  private enqueue(event: RawHookEvent): void {
    this.outbox.push(event);
    if (this.outbox.length > OUTBOX_LIMIT) {
      const dropped = this.outbox.length - OUTBOX_LIMIT;
      this.outbox.splice(0, dropped);
      this.log('warn', `outbox overflow: dropped ${dropped} oldest undelivered hook events`);
    }
    this.outboxDirty = true;
    this.send({ t: 'hook', event });
  }

  // ─────────────────── local control (CLI ⇄ daemon) ────────────

  private async onControl(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!safeEqual(String(req.headers['x-orch-local'] ?? ''), this.cfg.localToken)) return json(403, { error: 'forbidden' });
    try {
      const body = req.method === 'POST' ? JSON.parse((await this.readBody(req)) || '{}') : {};
      switch (url.pathname) {
        case '/control/status': {
          let server: unknown = null;
          if (this.connected) server = await this.request({ method: 'status', params: {} }, 5000).catch(() => null);
          return json(200, {
            version: AGENT_VERSION,
            pid: process.pid,
            connected: this.connected,
            rejected: this.rejected,
            serverUrl: this.cfg.serverUrl,
            hostId: this.cfg.hostId,
            name: this.cfg.name,
            allowedRoots: this.cfg.allowedRoots,
            info: this.info,
            pendingEvents: this.outbox.length,
            sessions: [...this.tracked.values()].map((t) => this.report(t)),
            server,
          });
        }
        case '/control/discover':
          return json(200, { panes: await this.discover() });
        case '/control/attach': {
          const sessionId = crypto.randomUUID();
          const report = await this.attachSession(sessionId, String(body.tmuxSession ?? ''), body.pane ?? null);
          this.send({ t: 'session', session: report });
          let bound: unknown = null;
          try {
            bound = await this.request({ method: 'bind', params: { sessionId, employee: body.employee ?? null, role: body.role ?? null } });
          } catch (e) {
            return json(200, { session: report, warning: `attached locally, but the server could not bind it: ${(e as Error).message}` });
          }
          return json(200, { session: report, bound });
        }
        case '/control/create': {
          const project = this.assertAllowed(String(body.project ?? ''));
          const result = await this.request({ method: 'create', params: { name: String(body.name ?? ''), project, role: body.role ?? null, model: body.model ?? null, autonomy: body.autonomy ?? null } }, 90000);
          return json(200, result);
        }
        case '/control/stop':
          json(200, { ok: true });
          setTimeout(() => void this.stop().then(() => process.exit(0)), 50);
          return;
        default:
          return json(404, { error: 'not found' });
      }
    } catch (e) {
      return json(400, { error: (e as Error).message });
    }
  }
}

/**
 * Resolve symlinks for the part of a path that exists, so a not-yet-created
 * directory is judged by where it would really live (and "../" or symlink
 * tricks cannot escape an allowed root).
 */
/** No path is longer than this on the systems the agent runs on (Linux: 4096, macOS: 1024). */
const PATH_LONGEST = 4096;
/** How many folders deep, over all the paths a command names, the fence follows them on the disk. */
const FENCE_LOOKUPS = 20_000;

function realpathOfDeepestExisting(abs: string): string {
  let current = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
}

/** One-shot enrollment: trade an enrollment token for a host credential. */
export function enroll(serverUrl: string, enrollmentToken: string, name: string, info: HostInfo, timeoutMs = 15000): Promise<{ hostId: string; credential: string; name: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(toWsUrl(serverUrl, '/ws/agent'));
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error(`no answer from ${serverUrl}`));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, enrollmentToken, enrollOnly: true, name, info } satisfies AgentToServer));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerToAgent;
      if (msg.t === 'welcome' && msg.credential) {
        clearTimeout(timer);
        ws.close();
        resolve({ hostId: msg.hostId, credential: msg.credential, name: msg.name });
      } else if (msg.t === 'rejected') {
        clearTimeout(timer);
        ws.close();
        reject(new Error(msg.reason));
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`cannot reach ${serverUrl}`));
    };
  });
}
