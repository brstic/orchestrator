import type { AgentRpc, ControlState, ServerToClient, TerminalScreen, TerminalSnapshot } from '@orchestrator/contracts';

export interface GatewayDeps {
  /** Call the host agent that owns a session. */
  rpc(hostId: string, rpc: AgentRpc, timeoutMs?: number): Promise<any>;
  /** Where a session lives and whether its host is reachable right now. */
  locate(sessionId: string): { hostId: string; online: boolean; running: boolean } | null;
  send(clientId: string, msg: ServerToClient): void;
  /** Persist + broadcast the new control state for a session. */
  onControlChange(sessionId: string, control: ControlState, controllerId: string | null): void;
  audit(actor: string, action: string, target: string, detail?: Record<string, unknown>): void;
  /** Called when an observer's keystrokes were refused (rate limited by the gateway). */
  onInputBlocked?(sessionId: string, clientId: string): void;
  /** Minimum gap between monitor frames for sessions a client is not focused on. */
  backgroundScreenIntervalMs?: number;
}

interface SessionState {
  viewers: Set<string>;
  controllerId: string | null;
  paused: boolean;
  subscribed: boolean;
  lastBlockedNotice: number;
}

interface ClientState {
  open: Set<string>;
  focus: string | null;
  screenSentAt: Map<string, number>;
  screenTimers: Map<string, NodeJS.Timeout>;
}

/**
 * Server-side terminal gateway: fans a session's output out to viewers and
 * enforces input ownership.
 *
 *   AGENT_CONTROLLED  nobody is watching; the agent works alone
 *   HUMAN_OBSERVING   viewers attached read-only — their keystrokes are dropped here
 *   HUMAN_CONTROLLED  exactly one client holds the keyboard
 *   PAUSED            the owner interrupted the agent and has not resumed it
 *   DISCONNECTED      the host (or the session's terminal) is unreachable
 *
 * Ownership is enforced on the server, never trusted to the UI.
 */
export class TerminalGateway {
  private sessions = new Map<string, SessionState>();
  private clients = new Map<string, ClientState>();
  readonly screens = new Map<string, TerminalScreen>();
  private deps: GatewayDeps;
  private bgInterval: number;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.bgInterval = deps.backgroundScreenIntervalMs ?? 2500;
  }

  private s(sessionId: string): SessionState {
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = { viewers: new Set(), controllerId: null, paused: false, subscribed: false, lastBlockedNotice: 0 };
      this.sessions.set(sessionId, st);
    }
    return st;
  }

  private c(clientId: string): ClientState {
    let st = this.clients.get(clientId);
    if (!st) {
      st = { open: new Set(), focus: null, screenSentAt: new Map(), screenTimers: new Map() };
      this.clients.set(clientId, st);
    }
    return st;
  }

  // ───────────── control state ─────────────

  controlOf(sessionId: string): { control: ControlState; controllerId: string | null } {
    const loc = this.deps.locate(sessionId);
    const st = this.sessions.get(sessionId);
    if (!loc || !loc.online || !loc.running) return { control: 'DISCONNECTED', controllerId: null };
    if (st?.controllerId) return { control: 'HUMAN_CONTROLLED', controllerId: st.controllerId };
    if (st?.paused) return { control: 'PAUSED', controllerId: null };
    if (st && st.viewers.size > 0) return { control: 'HUMAN_OBSERVING', controllerId: null };
    return { control: 'AGENT_CONTROLLED', controllerId: null };
  }

  /** True while Orchestrator itself must not type into the terminal. */
  isHumanControlled(sessionId: string): boolean {
    return !!this.sessions.get(sessionId)?.controllerId;
  }

  isPaused(sessionId: string): boolean {
    return !!this.sessions.get(sessionId)?.paused;
  }

  private publish(sessionId: string): void {
    const { control, controllerId } = this.controlOf(sessionId);
    this.deps.onControlChange(sessionId, control, controllerId);
    const st = this.sessions.get(sessionId);
    for (const viewer of st?.viewers ?? []) this.deps.send(viewer, { t: 'control', sessionId, control, controllerId, you: controllerId === viewer });
  }

  /** Re-evaluate after host connectivity or process state changed. */
  refresh(sessionId: string): void {
    const loc = this.deps.locate(sessionId);
    const st = this.sessions.get(sessionId);
    if (st && (!loc || !loc.online || !loc.running)) {
      // Nobody can hold the keyboard of a terminal that is not there.
      st.controllerId = null;
      st.subscribed = false;
    }
    this.publish(sessionId);
  }

  setPaused(sessionId: string, paused: boolean): void {
    const st = this.s(sessionId);
    if (st.paused === paused) return;
    st.paused = paused;
    this.publish(sessionId);
  }

  // ───────────── viewers ─────────────

  registerClient(clientId: string): void {
    this.c(clientId);
    // New clients immediately get the latest known frame for every monitor.
    for (const [sessionId, screen] of this.screens) this.deps.send(clientId, { t: 'term.screen', sessionId, screen });
  }

  async open(clientId: string, sessionId: string): Promise<void> {
    const loc = this.deps.locate(sessionId);
    if (!loc) throw new Error('unknown session');
    if (!loc.online) throw new Error('the host running this session is offline');
    const st = this.s(sessionId);
    const client = this.c(clientId);
    st.viewers.add(clientId);
    client.open.add(sessionId);
    this.publish(sessionId);
    try {
      // The agent starts forwarding before it snapshots, so nothing is lost in between:
      // the viewer discards chunks with seq <= snapshot.seq.
      const snapshot = (await this.deps.rpc(loc.hostId, { method: 'term.subscribe', params: { sessionId } }, 15000)) as TerminalSnapshot;
      st.subscribed = true;
      if (st.viewers.has(clientId)) this.deps.send(clientId, { t: 'term.snapshot', snapshot });
    } catch (e) {
      st.viewers.delete(clientId);
      client.open.delete(sessionId);
      this.publish(sessionId);
      throw e;
    }
  }

  close(clientId: string, sessionId: string): void {
    const st = this.sessions.get(sessionId);
    const client = this.clients.get(clientId);
    client?.open.delete(sessionId);
    if (!st) return;
    st.viewers.delete(clientId);
    if (st.controllerId === clientId) {
      st.controllerId = null;
      this.deps.audit(`client:${clientId}`, 'terminal.control_released', sessionId, { reason: 'viewer closed' });
    }
    if (st.viewers.size === 0 && st.subscribed) {
      st.subscribed = false;
      const loc = this.deps.locate(sessionId);
      if (loc?.online) void this.deps.rpc(loc.hostId, { method: 'term.unsubscribe', params: { sessionId } }, 5000).catch(() => undefined);
    }
    this.publish(sessionId);
  }

  clientGone(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    for (const sessionId of [...client.open]) this.close(clientId, sessionId);
    for (const t of client.screenTimers.values()) clearTimeout(t);
    this.clients.delete(clientId);
  }

  /** Push a fresh snapshot to everyone watching (after a resize or a reattach on the host). */
  async resync(sessionId: string): Promise<void> {
    const st = this.sessions.get(sessionId);
    const loc = this.deps.locate(sessionId);
    if (!st || !st.viewers.size || !loc?.online) return;
    try {
      const snapshot = (await this.deps.rpc(loc.hostId, { method: 'term.subscribe', params: { sessionId } }, 15000)) as TerminalSnapshot;
      st.subscribed = true;
      for (const viewer of st.viewers) this.deps.send(viewer, { t: 'term.snapshot', snapshot });
    } catch {
      /* the next output or reconnect will retry */
    }
  }

  /** The host came back: re-establish streams for viewers that are still watching. */
  async hostReconnected(sessionIds: string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const st = this.sessions.get(sessionId);
      if (!st) continue;
      st.subscribed = false;
      this.refresh(sessionId);
      if (st.viewers.size) await this.resync(sessionId);
    }
  }

  sessionClosed(sessionId: string, reason: string): void {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    st.controllerId = null;
    st.subscribed = false;
    for (const viewer of st.viewers) this.deps.send(viewer, { t: 'term.closed', sessionId, reason });
    this.publish(sessionId);
  }

  // ───────────── ownership ─────────────

  acquire(clientId: string, sessionId: string, actor: string): void {
    const st = this.s(sessionId);
    const { control } = this.controlOf(sessionId);
    if (control === 'DISCONNECTED') throw new Error('this terminal is not reachable right now');
    if (!st.viewers.has(clientId)) throw new Error('open the terminal before taking control');
    if (st.controllerId && st.controllerId !== clientId) throw new Error('another operator is controlling this terminal');
    if (st.controllerId === clientId) return;
    st.controllerId = clientId;
    this.deps.audit(actor, 'terminal.control_acquired', sessionId, { clientId });
    this.publish(sessionId);
  }

  release(clientId: string, sessionId: string, actor: string): void {
    const st = this.sessions.get(sessionId);
    if (!st || st.controllerId !== clientId) return;
    st.controllerId = null;
    this.deps.audit(actor, 'terminal.control_released', sessionId, { clientId });
    this.publish(sessionId);
  }

  /** Keystrokes from a UI client. Dropped unless that client holds control. */
  async input(clientId: string, sessionId: string, data: string): Promise<boolean> {
    const st = this.sessions.get(sessionId);
    if (!st || st.controllerId !== clientId) {
      const now = Date.now();
      if (st && now - st.lastBlockedNotice > 5000) {
        st.lastBlockedNotice = now;
        this.deps.onInputBlocked?.(sessionId, clientId);
      }
      return false;
    }
    const loc = this.deps.locate(sessionId);
    if (!loc?.online) return false;
    if (data.length > 1_000_000) throw new Error('input too large');
    await this.deps.rpc(loc.hostId, { method: 'term.input', params: { sessionId, data } }, 10000);
    return true;
  }

  async resize(clientId: string, sessionId: string, cols: number, rows: number): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st || st.controllerId !== clientId) return;
    const loc = this.deps.locate(sessionId);
    if (!loc?.online) return;
    await this.deps.rpc(loc.hostId, { method: 'term.resize', params: { sessionId, cols, rows } }, 10000);
  }

  // ───────────── streams from hosts ─────────────

  onOutput(sessionId: string, seq: number, data: string): void {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    for (const viewer of st.viewers) this.deps.send(viewer, { t: 'term.output', sessionId, seq, data });
  }

  setFocus(clientId: string, sessionId: string | null): void {
    const client = this.c(clientId);
    client.focus = sessionId;
    if (sessionId) {
      const screen = this.screens.get(sessionId);
      if (screen) this.deps.send(clientId, { t: 'term.screen', sessionId, screen });
    }
  }

  /**
   * Monitor frames. The session a client is standing next to updates at full
   * rate; every other monitor in the office is throttled.
   */
  onScreen(sessionId: string, screen: TerminalScreen): void {
    this.screens.set(sessionId, screen);
    const now = Date.now();
    for (const [clientId, client] of this.clients) {
      if (client.focus === sessionId) {
        this.deps.send(clientId, { t: 'term.screen', sessionId, screen });
        client.screenSentAt.set(sessionId, now);
        continue;
      }
      const last = client.screenSentAt.get(sessionId) ?? 0;
      if (now - last >= this.bgInterval) {
        client.screenSentAt.set(sessionId, now);
        this.deps.send(clientId, { t: 'term.screen', sessionId, screen });
      } else if (!client.screenTimers.has(sessionId)) {
        const timer = setTimeout(
          () => {
            client.screenTimers.delete(sessionId);
            const latest = this.screens.get(sessionId);
            if (!latest || !this.clients.has(clientId)) return;
            client.screenSentAt.set(sessionId, Date.now());
            this.deps.send(clientId, { t: 'term.screen', sessionId, screen: latest });
          },
          this.bgInterval - (now - last),
        );
        timer.unref?.();
        client.screenTimers.set(sessionId, timer);
      }
    }
  }

  forgetSession(sessionId: string): void {
    this.sessionClosed(sessionId, 'session removed');
    this.sessions.delete(sessionId);
    this.screens.delete(sessionId);
  }

  viewerCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.viewers.size ?? 0;
  }
}
