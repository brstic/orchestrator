import type { ClientToServer, ServerToClient } from '@orchestrator/contracts';

declare global {
  interface Window {
    /** Injected by the Electron preload script in the desktop app. */
    orchestrator?: { serverUrl: string; token: string; platform: string };
  }
}

function resolveBase(): string {
  if (window.orchestrator?.serverUrl) return window.orchestrator.serverUrl.replace(/\/+$/, '');
  const stored = localStorage.getItem('orch.server');
  // Served by the Orchestrator server itself (or proxied by Vite in development).
  return stored ?? '';
}

function resolveToken(): string {
  if (window.orchestrator?.token) return window.orchestrator.token;
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem('orch.token', fromUrl);
    // Keep the token out of the address bar and history.
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    return fromUrl;
  }
  return localStorage.getItem('orch.token') ?? '';
}

export const serverBase = resolveBase();
let token = resolveToken();

export function setToken(t: string): void {
  token = t.trim();
  localStorage.setItem('orch.token', token);
}

export function hasToken(): boolean {
  return !!token;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${serverBase}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) throw new ApiError(parsed?.error ?? `${method} ${path} failed (${res.status})`, res.status);
  return parsed as T;
}

export type ConnState = 'connecting' | 'online' | 'offline' | 'unauthorized';

type Handler = (msg: ServerToClient) => void;

/** The live link to the server: entity updates, events and terminal streams. Reconnects on its own. */
export class Connection {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private stateHandlers = new Set<(s: ConnState) => void>();
  private retry = 500;
  private timer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUs = false;
  state: ConnState = 'connecting';
  /** Messages to replay after a reconnect (open terminals, focus). */
  private sticky = new Map<string, ClientToServer>();

  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onState(h: (s: ConnState) => void): () => void {
    this.stateHandlers.add(h);
    return () => this.stateHandlers.delete(h);
  }

  private setState(s: ConnState): void {
    this.state = s;
    for (const h of this.stateHandlers) h(s);
  }

  connect(): void {
    this.closedByUs = false;
    if (!token) return this.setState('unauthorized');
    const base = serverBase || window.location.origin;
    const url = `${base.replace(/^http/, 'ws')}/ws/client?token=${encodeURIComponent(token)}`;
    this.setState(this.state === 'online' ? 'offline' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.schedule();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      for (const msg of this.sticky.values()) ws.send(JSON.stringify(msg));
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping' }), 25000);
    };
    ws.onmessage = (ev) => {
      let msg: ServerToClient;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === 'ready') this.setState('online');
      for (const h of this.handlers) h(msg);
    };
    ws.onclose = (ev) => {
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4003) return this.setState('unauthorized');
      this.setState('offline');
      if (!this.closedByUs) this.schedule();
    };
    ws.onerror = () => undefined;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, this.retry);
    this.retry = Math.min(8000, this.retry * 1.6);
  }

  send(msg: ClientToServer): void {
    // Remember what must survive a reconnect.
    if (msg.t === 'term.open') this.sticky.set(`term:${msg.sessionId}`, msg);
    else if (msg.t === 'term.close') this.sticky.delete(`term:${msg.sessionId}`);
    else if (msg.t === 'screens.focus') this.sticky.set('focus', msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
  }
}

export const connection = new Connection();
