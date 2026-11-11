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
import { PROTOCOL_VERSION, redactSecrets, slugify } from '@orchestrator/contracts';
import {
  NESTED_SESSION_ENV,
  PaneStream,
  ResourceSampler,
  Tmux,
  claudeVersion,
  claudeEffortLevels,
  findBrowserMcp,
  currentBranch,
  ensureWorktree,
  gitDiff,
  gitLog,
  gitStatus,
  inspectPath,
  listFolders,
  listMarkdown,
  looksLikeClaude,
  mergeBranch,
  integrationStatus,
  promoteIntegration,
  planClaudeLaunch,
  readMarkdown,
  readTranscriptUsage,
  runVerify,
  startBranch,
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
}

interface PendingHook {
  resolve: (output: Record<string, unknown> | null) => void;
  timer: NodeJS.Timeout;
  /** What was sent, so it can be sent again if the connection drops before the server answers. */
  event?: RawHookEvent;
}

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

const OUTBOX_LIMIT = 5000;

/**
 * The host agent daemon. It owns nothing but observation and delivery: tmux
 * sessions keep running whether or not this process (or the server) is alive.
 */
export class HostAgent {
  readonly cfg: AgentConfig;
  readonly home: string;
  readonly p: ReturnType<typeof paths>;
  readonly tmux: Tmux;
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
  private pendingRequests = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private hookServer: http.Server | null = null;
  private timers: NodeJS.Timeout[] = [];
  private sampler = new ResourceSampler();
  private info: HostInfo | null = null;
  private tickCount = 0;
  private ticking = false;
  private rejected: string | null = null;
  log: Logger;
  onWelcome: (() => void) | null = null;

  constructor(cfg: AgentConfig, home: string, log?: Logger) {
    this.cfg = cfg;
    this.home = home;
    this.p = paths(home);
    this.tmux = new Tmux({ socketName: cfg.tmuxSocketName });
    this.log = log ?? ((level, msg) => console.error(`[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`));
  }

  // ───────────────────────── lifecycle ─────────────────────────

  async start(): Promise<void> {
    if (!this.cfg.serverUrl) throw new Error('not logged in: run `orchestrator-agent login --server <url> --token <enrollment-token>` first');
    this.info = await this.collectInfo();
    if (!this.info.tmuxVersion) this.log('warn', 'tmux was not found on PATH; sessions cannot be created or attached');
    this.loadState();
    await this.startHookServer();
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
    // Release the runners' long-polls and any hook still being held: an unanswered hook just means
    // "no decision", and the worker falls back to asking at its own terminal.
    for (const rt of this.runtime.values()) rt.inboxWaiter?.();
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
    // Blocking hooks cannot be answered any more; let Claude Code fall back to its own dialog.
    for (const [id, pending] of this.pendingHooks) {
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
        if (msg.credential || msg.hostId !== this.cfg.hostId) {
          this.cfg.hostId = msg.hostId;
          if (msg.credential) this.cfg.credential = msg.credential;
          saveConfig(this.cfg, this.home);
        }
        this.log('info', `connected to ${this.cfg.serverUrl} as host "${msg.name}" (${msg.hostId})`);
        this.send({ t: 'sessions', sessions: [...this.tracked.values()].filter((t) => !t.gone || t.origin === 'managed').map((t) => this.report(t)) });
        for (const ev of this.outbox) this.send({ t: 'hook', event: ev });
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
    if (existing && existingPane) {
      // Same tmux session, same pane, scrollback preserved: only the dead process is restarted.
      tmuxSession = existing.tmuxSession;
      paneId = existing.paneId;
      await this.tmux.respawnPane(paneId, cwd, plan.argv);
    } else {
      tmuxSession = `orch-${slugify(spec.displayName, 24)}-${sessionId.slice(0, 6)}`;
      const pane = await this.tmux.newSession({ name: tmuxSession, cwd, cols: spec.cols, rows: spec.rows, argv: plan.argv });
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
  private planManagedLaunch(spec: LaunchSpec, sessionId: string, sessionDir: string, hookToken: string, sdkEntry: string): { argv: string[]; files: Array<{ path: string; content: string }>; hookEvents: string[] } {
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
    } catch (e) {
      this.log('warn', `monitor tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
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
      case 'fs.inspect':
        return inspectPath(this.assertAllowed(rpc.params.path));
      case 'fs.browse': {
        // Choosing a folder for an employee: only inside the folders this host was told to allow.
        const roots = this.cfg.allowedRoots.map((r) => path.resolve(r));
        const listing = await listFolders(this.assertAllowed(rpc.params.path || roots[0] || os.homedir()));
        const atRoot = roots.some((r) => realpathOfDeepestExisting(r) === listing.path);
        return { ...listing, parent: atRoot ? null : listing.parent, roots };
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
    if (payload.hook_event_name !== 'PreToolUse' || payload.tool_name !== 'Bash') return null;
    const command = String(payload.tool_input?.command ?? '');
    for (const pattern of t.spec?.highRiskPatterns ?? []) {
      try {
        if (new RegExp(pattern, 'i').test(command)) {
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

  private lastLimits = new Map<string, string>();

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
    if (!fiveHour && !sevenDay) return; // not a subscription account, or no answer yet in this session
    const who = this.claudeAccount(tracked.spec?.env?.CLAUDE_CONFIG_DIR || null);
    const msg = { t: 'limits' as const, sessionId: tracked.sessionId, configDir: tracked.spec?.env?.ORCH_CLAUDE_ACCOUNT || null, email: who.email, organization: who.organization, fiveHour, sevenDay };
    // The same figures again are not news.
    const key = JSON.stringify([msg.fiveHour, msg.sevenDay, msg.email]);
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
    const clean = (x: string) => String(x ?? '').replace(/[^A-Za-z0-9._ ()@+-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
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
    const inside = (root: string) => {
      const r = realpathOfDeepestExisting(path.resolve(root));
      return real === r || real.startsWith(r + path.sep);
    };
    if (![...this.cfg.allowedRoots, path.dirname(this.p.sessions), os.tmpdir(), '/tmp'].some(inside)) throw new Error(`${abs} is outside the folders this machine lets the office read`);
    // Never the office's own secrets on this machine, wherever the roots reach.
    if (/(^|\/)(config\.json|mcp\.json|settings\.json|state\.json|outbox\.json|vault(\.mjs)?|\.claude\.json|\.credentials\.json)$/.test(real) && (inside(path.dirname(this.p.sessions)) || /\/\.claude[^/]*\//.test(real))) throw new Error('that file is not one to attach');
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
  private describeAccount(raw: string | null, prepare: boolean): { dir: string | null; path: string; exists: boolean; loggedIn: boolean; email: string | null; organization: string | null; login: string; error?: string } {
    const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    if (!raw) {
      const who = this.claudeAccount(null);
      return { dir: null, path: base, exists: true, loggedIn: !!who.email || fs.existsSync(path.join(os.homedir(), '.claude.json')), ...who, login: `${this.cfg.claudeBin}   (then /login)` };
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
    const who = this.claudeAccount(dir);
    return { dir: raw, path: dir, exists: fs.existsSync(dir), loggedIn: fs.existsSync(path.join(dir, '.claude.json')) && !!who.email, ...who, login };
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

    const event: RawHookEvent = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      hostSeq: ++this.hostSeq,
      sessionId: tracked.sessionId,
      tmuxPane: pane ?? tracked.paneId,
      payload,
    };

    const local = this.localPolicy(tracked, payload);
    if (local) {
      event.payload = { ...payload, orch_policy: 'high_risk' };
      this.enqueue(event);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(local));
      return;
    }

    if (!this.isBlocking(payload) || !this.connected) {
      this.enqueue(event);
      res.writeHead(200);
      res.end();
      return;
    }

    // Blocking hook: hold the request open while the server (and possibly the owner) decides.
    const requestId = crypto.randomUUID();
    const waitMs = payload.hook_event_name === 'Stop' ? 5000 : this.cfg.approvalWaitSeconds * 1000;
    let finished = false;
    const output = await new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHooks.delete(requestId);
        resolve(null);
      }, waitMs);
      this.pendingHooks.set(requestId, { resolve, timer, event });
      res.on('close', () => {
        if (finished) return;
        // Claude Code gave up on the hook (timeout, interrupt, session ended).
        const pending = this.pendingHooks.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingHooks.delete(requestId);
          this.send({ t: 'hook.settled', requestId, outcome: 'abandoned', detail: 'hook connection closed before a decision' });
          pending.resolve(null);
        }
      });
      if (!this.send({ t: 'hook.request', requestId, event })) {
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
