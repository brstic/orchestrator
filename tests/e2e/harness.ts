/**
 * End-to-end test harness: a real server, a real host agent and real tmux
 * sessions, with the fake-claude fixture standing in for the model.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSession, Employee, FullState, Project, Question, ServerToClient, Task } from '@orchestrator/contracts';
import { b64decode } from '@orchestrator/contracts';
import { HostAgent, enroll } from '../../apps/host-agent/src/agent.ts';
import { defaultConfig, saveConfig, type AgentConfig } from '../../apps/host-agent/src/config.ts';
import { startServer, type RunningServer } from '../../apps/server/src/server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = path.join(here, '..', 'fixtures', 'fake-claude.mjs');
/** A stand-in for the Claude Agent SDK package, for tests of the SDK-managed runtime. */
export const FAKE_AGENT_SDK = path.join(here, '..', 'fixtures', 'fake-agent-sdk');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeout?: number; label?: string; interval?: number } = {}): Promise<NonNullable<T>> {
  const end = Date.now() + (opts.timeout ?? 15000);
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${opts.label ?? 'condition'}${last ? `: ${(last as Error).message}` : ''}`);
    await sleep(opts.interval ?? 60);
  }
}

export class OfficeClient {
  ws: WebSocket;
  state!: FullState;
  clientId = '';
  messages: ServerToClient[] = [];
  /** Terminal text per session, built from snapshot + output like the real UI does. */
  terminals = new Map<string, { text: string; seq: number; snapshots: number }>();
  /** Recent output per session, so chunks that overtake a snapshot can be replayed onto it. */
  private recent = new Map<string, Array<{ seq: number; text: string }>>();
  control = new Map<string, { control: string; you: boolean }>();
  errors: string[] = [];
  private ready: Promise<void>;

  constructor(url: string, token: string) {
    this.ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws/client?token=${token}`);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onerror = () => reject(new Error('client websocket failed'));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as ServerToClient;
        this.messages.push(msg);
        this.apply(msg);
        if (msg.t === 'ready') resolve();
      };
    });
  }

  opened(): Promise<void> {
    return this.ready;
  }

  private list(kind: string): any[] | null {
    const map: Record<string, keyof FullState> = { host: 'hosts', employee: 'employees', session: 'sessions', project: 'projects', task: 'tasks', question: 'questions', message: 'messages', collab: 'collabs', notification: 'notifications', meeting: 'meetings', artifact: 'artifacts', lesson: 'lessons', improvement: 'improvements' };
    return map[kind] ? (this.state[map[kind]] as any[]) : null;
  }

  private apply(msg: ServerToClient): void {
    switch (msg.t) {
      case 'ready':
        this.state = msg.state;
        this.clientId = msg.clientId;
        break;
      case 'entity': {
        const list = this.list(msg.kind);
        if (list) {
          const i = list.findIndex((x) => x.id === msg.data.id);
          if (msg.op === 'remove') {
            if (i >= 0) list.splice(i, 1);
          } else if (i >= 0) list[i] = msg.data;
          else list.push(msg.data);
        } else if (msg.kind === 'company') this.state.company = msg.data;
        else if (msg.kind === 'settings') this.state.settings = msg.data;
        else if (msg.kind === 'layout') this.state.layout = msg.data;
        else if (msg.kind === 'milestone') {
          const i = this.state.milestones.findIndex((m) => m.key === msg.data.key);
          if (i >= 0) this.state.milestones[i] = msg.data;
        }
        break;
      }
      case 'event':
        this.state.events.push(msg.event);
        break;
      case 'term.snapshot': {
        const prev = this.terminals.get(msg.snapshot.sessionId);
        const t = { text: Buffer.from(b64decode(msg.snapshot.data)).toString('utf8'), seq: msg.snapshot.seq, snapshots: (prev?.snapshots ?? 0) + 1 };
        // Output newer than the snapshot may already have arrived; it belongs after it.
        for (const chunk of this.recent.get(msg.snapshot.sessionId) ?? []) {
          if (chunk.seq > t.seq) {
            t.text += chunk.text;
            t.seq = chunk.seq;
          }
        }
        this.terminals.set(msg.snapshot.sessionId, t);
        break;
      }
      case 'term.output': {
        const text = Buffer.from(b64decode(msg.data)).toString('utf8');
        let list = this.recent.get(msg.sessionId);
        if (!list) this.recent.set(msg.sessionId, (list = []));
        list.push({ seq: msg.seq, text });
        if (list.length > 400) list.splice(0, list.length - 400);
        const t = this.terminals.get(msg.sessionId);
        // Chunks at or before the snapshot are already contained in it.
        if (t && msg.seq > t.seq) {
          t.text += text;
          t.seq = msg.seq;
        }
        break;
      }
      case 'control':
        this.control.set(msg.sessionId, { control: msg.control, you: msg.you });
        break;
      case 'error':
        this.errors.push(msg.message);
        break;
    }
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  terminal(sessionId: string): string {
    return this.terminals.get(sessionId)?.text ?? '';
  }

  close(): void {
    this.ws.close();
  }
}

export interface Harness {
  tmp: string;
  server: RunningServer;
  agent: HostAgent;
  agentHome: string;
  agentCfg: AgentConfig;
  url: string;
  token: string;
  hostId: string;
  tmuxSocket: string;
  api<T = any>(method: string, pathname: string, body?: unknown): Promise<T>;
  apiRaw(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: any }>;
  client(): Promise<OfficeClient>;
  makeRepo(name: string, opts?: { test?: string }): string;
  git(cwd: string, ...args: string[]): string;
  employee(name: string, role: string, extra?: Record<string, unknown>): Promise<Employee>;
  project(name: string, repo: string | null, extra?: Record<string, unknown>): Promise<Project>;
  task(input: Record<string, unknown>): Promise<Task>;
  state(): Promise<FullState>;
  session(employeeId: string): Promise<AgentSession | undefined>;
  getTask(id: string): Promise<Task>;
  openQuestion(employeeId: string, kind?: string): Promise<Question | undefined>;
  restartAgent(): Promise<void>;
  stopAgent(): Promise<void>;
  startAgent(): Promise<void>;
  restartServer(): Promise<void>;
  tmux(...args: string[]): string;
  /** Enroll and start another host agent (its own state directory and tmux server): a second machine. */
  addHost(name: string, overrides?: Partial<AgentConfig>, via?: { serverUrl?: string; enrollToken?: string }): Promise<{ hostId: string; agent: HostAgent; cfg: AgentConfig; root: string; tmux: (...args: string[]) => string; stop: () => Promise<void> }>;
  cleanup(): Promise<void>;
}

let counter = 0;

export async function createHarness(opts: { timings?: Record<string, number>; approvalWaitSeconds?: number; database?: string; memoryBin?: string | null } = {}): Promise<Harness> {
  let base = os.tmpdir();
  // Unix socket paths are limited to ~104 bytes on macOS; keep the root short.
  if (base.length > 40) base = '/tmp';
  const tmp = fs.mkdtempSync(path.join(base, 'orch-e2e-'));
  const tmuxSocket = `orch-e2e-${process.pid}-${++counter}`;
  const wrapper = path.join(tmp, 'fake-claude');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
  const dataDir = path.join(tmp, 'server');
  const timings = { askBossWaitMs: 6000, meetingRoundMs: 12000, deliverySettleMs: 120, deliveryConfirmMs: 6000, verifyTimeoutMs: 30000, scheduleDebounceMs: 40, ...(opts.timings ?? {}) };
  let server = await startServer({ dataDir, host: '127.0.0.1', port: 0, quiet: true, timings, database: opts.database, memoryBin: opts.memoryBin ?? null });
  const url = server.url;
  const port = Number(new URL(url).port);
  const token = server.ownerToken;

  const agentHome = path.join(tmp, 'agent');
  const cfg: AgentConfig = { ...defaultConfig(), serverUrl: url, name: 'test-host', allowedRoots: [fs.realpathSync(tmp)], tmuxSocketName: tmuxSocket, claudeBin: wrapper, approvalWaitSeconds: opts.approvalWaitSeconds ?? 20, remoteAttach: 'any' };
  const info = { hostname: 'test-host', platform: process.platform, arch: process.arch, agentVersion: 'test', tmuxVersion: 'test', claudeVersion: '2.1.321', cpus: 1, totalMemBytes: 1, user: 'test' };
  const enrolled = await enroll(url, server.localEnrollToken(), 'test-host', info);
  cfg.hostId = enrolled.hostId;
  cfg.credential = enrolled.credential;
  saveConfig(cfg, agentHome);
  let agent = new HostAgent(cfg, agentHome, () => undefined);
  await agent.start();
  await waitFor(() => agent.isConnected, { label: 'agent connect' });

  const clients: OfficeClient[] = [];
  const extraHosts: Array<{ stop: () => Promise<void>; socket: string }> = [];
  const apiRaw = async (method: string, pathname: string, body?: unknown) => {
    const res = await fetch(`${url}/api${pathname}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };
  const api = async <T = any>(method: string, pathname: string, body?: unknown): Promise<T> => {
    const res = await apiRaw(method, pathname, body);
    if (res.status >= 400) throw new Error(`${method} ${pathname} → ${res.status}: ${res.body?.error ?? JSON.stringify(res.body)}`);
    return res.body as T;
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } }).trim();
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8' });

  const h: Harness = {
    tmp,
    get server() {
      return server;
    },
    get agent() {
      return agent;
    },
    agentHome,
    agentCfg: cfg,
    url,
    token,
    hostId: enrolled.hostId,
    tmuxSocket,
    api,
    apiRaw,
    async client() {
      const c = new OfficeClient(url, token);
      await c.opened();
      clients.push(c);
      return c;
    },
    makeRepo(name, o = {}) {
      const dir = path.join(fs.realpathSync(tmp), name);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { test: o.test ?? 'node check.js' } }, null, 2));
      // The "test suite": fails when a file named FAIL exists or a tracked file contains BROKEN.
      fs.writeFileSync(path.join(dir, 'check.js'), `const fs=require('fs');if(fs.existsSync('FAIL')){console.error('1 failing: FAIL marker present');process.exit(1)}for(const f of fs.readdirSync('.')){if(f.endsWith('.txt')&&fs.readFileSync(f,'utf8').includes('BROKEN')){console.error('1 failing: '+f+' is broken');process.exit(1)}}console.log('all checks passed');\n`);
      fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'initial commit');
      return dir;
    },
    git,
    employee: (name, role, extra = {}) => api<Employee>('POST', '/employees', { name, roleKey: role, hostId: enrolled.hostId, ...extra }),
    project: (name, repo, extra = {}) => api<Project>('POST', '/projects', { name, repoPath: repo, hostId: enrolled.hostId, ...extra }),
    task: (input) => api<Task>('POST', '/tasks', input),
    state: () => api<FullState>('GET', '/state'),
    async session(employeeId) {
      const s = await api<FullState>('GET', '/state');
      const all = s.sessions.filter((x) => x.employeeId === employeeId);
      return all.find((x) => x.status === 'running' || x.status === 'starting') ?? all[all.length - 1];
    },
    async getTask(id) {
      return (await api<FullState>('GET', '/state')).tasks.find((t) => t.id === id)!;
    },
    async openQuestion(employeeId, kind) {
      return (await api<FullState>('GET', '/state')).questions.find((q) => q.employeeId === employeeId && q.status === 'open' && (!kind || q.kind === kind));
    },
    async stopAgent() {
      await agent.stop();
    },
    async startAgent() {
      agent = new HostAgent(cfg, agentHome, () => undefined);
      await agent.start();
      await waitFor(() => agent.isConnected, { label: 'agent reconnect' });
    },
    async restartAgent() {
      await h.stopAgent();
      await h.startAgent();
    },
    async restartServer() {
      for (const c of clients.splice(0)) c.close();
      await server.close().catch(() => undefined);
      server = await startServer({ dataDir, host: '127.0.0.1', port, quiet: true, timings, database: opts.database, memoryBin: opts.memoryBin ?? null });
      await waitFor(() => agent.isConnected, { label: 'agent reconnect after server restart', timeout: 20000 });
    },
    tmux,
    async addHost(name, overrides = {}, via = {}) {
      const home = path.join(tmp, `agent-${name}`);
      const root = path.join(fs.realpathSync(tmp), `machine-${name}`);
      fs.mkdirSync(root, { recursive: true });
      const socket = `${tmuxSocket}-${name}`;
      const hostCfg: AgentConfig = { ...defaultConfig(), serverUrl: via.serverUrl ?? url, name, allowedRoots: [root], tmuxSocketName: socket, claudeBin: wrapper, approvalWaitSeconds: 20, remoteAttach: 'any', ...overrides };
      const enrolledHost = await enroll(via.serverUrl ?? url, via.enrollToken ?? server.localEnrollToken(), name, { ...info, hostname: name });
      hostCfg.hostId = enrolledHost.hostId;
      hostCfg.credential = enrolledHost.credential;
      saveConfig(hostCfg, home);
      const other = new HostAgent(hostCfg, home, () => undefined);
      await other.start();
      await waitFor(() => other.isConnected, { label: `${name} connect` });
      const stop = async () => {
        await other.stop().catch(() => undefined);
      };
      extraHosts.push({ stop, socket });
      return { hostId: enrolledHost.hostId, agent: other, cfg: hostCfg, root, tmux: (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' }), stop };
    },
    async cleanup() {
      for (const c of clients) c.close();
      for (const x of extraHosts) {
        await x.stop();
        try {
          execFileSync('tmux', ['-L', x.socket, 'kill-server'], { stdio: 'ignore' });
        } catch {
          /* no server */
        }
        fs.rmSync(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, x.socket), { force: true });
      }
      await agent.stop().catch(() => undefined);
      try {
        execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
      } catch {
        /* no server */
      }
      await server.close().catch(() => undefined);
      fs.rmSync(tmp, { recursive: true, force: true });
      // tmux leaves the socket file of a dedicated server behind.
      fs.rmSync(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, tmuxSocket), { force: true });
    },
  };
  return h;
}
