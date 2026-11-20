import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AGENT_VERSION = '0.1.0';

export interface AgentConfig {
  /** ws:// or wss:// base URL of the Orchestrator server, e.g. http://127.0.0.1:4600 */
  serverUrl: string | null;
  hostId: string | null;
  /** Long-lived host credential issued at enrollment. Revocable server-side. */
  credential: string | null;
  name: string;
  /**
   * Directories this agent is willing to operate in. Sessions, git operations
   * and verification commands outside these roots are refused.
   */
  allowedRoots: string[];
  /** Optional tmux `-L` socket name. Null = the user's default tmux server. */
  tmuxSocketName: string | null;
  claudeBin: string;
  /**
   * Where Claude Code keeps its conversations on this machine for an employee with no account folder of their own
   * (`~/.claude`, or `CLAUDE_CONFIG_DIR`). Only for a move (`docs/MOVE.md`); the tests point it elsewhere.
   */
  claudeHome?: string;
  /** Local Codex CLI executable, using this host user's authentication. */
  codexBin?: string;
  /** Model and reasoning effort supported by this host’s Codex account. */
  codexModel?: string;
  codexEffort?: string;
  /** How long a permission/question hook may wait for the owner before falling back to the terminal dialog. */
  approvalWaitSeconds: number;
  /** How long a request for a decision goes on waiting after the office is lost (its restart), before Claude Code's own prompt is let through. Default 90; 0: not at all. */
  linkGraceSeconds?: number;
  /** How long a deciding hook of a session started from here keeps trying to reach this agent while it is restarted. Default 45. */
  hookRetrySeconds?: number;
  /** Allow the server to run project verification commands (tests) on this host. */
  allowVerify: boolean;
  /** Allow headless `claude -p` runs for command interpretation. */
  allowHeadless: boolean;
  /**
   * Which already-running tmux sessions the *office* may attach on its own:
   *   claude — only panes running Claude Code (default)
   *   any    — any pane (a shell pane attached this way is a remote shell for the owner)
   *   none   — nothing; sessions must be attached with `orchestrator-agent attach` on this machine
   * The local operator can always attach anything explicitly with the CLI.
   */
  remoteAttach: 'claude' | 'any' | 'none';
  /**
   * Where the Claude Agent SDK lives, for SDK-managed workers: the package directory or its
   * sdk.mjs. Null = look in <agent home>/node_modules and next to the agent. Install it with
   * `orchestrator-agent sdk install`. It adds the SDK-managed runtime on this host.
   */
  sdkPath: string | null;
  /** Override the hook events to install (null = detect from the Claude Code version). */
  hookEvents: string[] | null;
  /** Secret for the local control socket (CLI ⇄ daemon). */
  localToken: string;
}

export function agentHome(): string {
  return process.env.ORCH_AGENT_HOME ? path.resolve(process.env.ORCH_AGENT_HOME) : path.join(os.homedir(), '.orchestrator', 'agent');
}

export function paths(home = agentHome()) {
  return {
    home,
    config: path.join(home, 'config.json'),
    state: path.join(home, 'state.json'),
    outbox: path.join(home, 'outbox.json'),
    socket: path.join(home, 'agent.sock'),
    sessions: path.join(home, 'sessions'),
    log: path.join(home, 'agent.log'),
    pid: path.join(home, 'agent.pid'),
  };
}

export function defaultConfig(): AgentConfig {
  return {
    serverUrl: null,
    hostId: null,
    credential: null,
    name: os.hostname().replace(/\.local$/, ''),
    allowedRoots: [os.homedir()],
    tmuxSocketName: null,
    claudeBin: 'claude',
    codexBin: 'codex',
    approvalWaitSeconds: 1800,
    allowVerify: true,
    allowHeadless: true,
    remoteAttach: 'claude',
    sdkPath: null,
    hookEvents: null,
    localToken: crypto.randomBytes(24).toString('hex'),
  };
}

export function ensureHome(home = agentHome()): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(home, 0o700);
  } catch {
    /* best effort */
  }
}

export function loadConfig(home = agentHome()): AgentConfig {
  ensureHome(home);
  const p = paths(home).config;
  let cfg = defaultConfig();
  if (fs.existsSync(p)) {
    try {
      cfg = { ...cfg, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    } catch (e) {
      throw new Error(`cannot parse ${p}: ${(e as Error).message}`);
    }
  } else {
    saveConfig(cfg, home);
  }
  return cfg;
}

export function saveConfig(cfg: AgentConfig, home = agentHome()): void {
  ensureHome(home);
  writePrivate(paths(home).config, JSON.stringify(cfg, null, 2));
}

/** Atomic write with owner-only permissions (credentials and hook tokens live here). */
export function writePrivate(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function toWsUrl(serverUrl: string, pathname: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  u.pathname = pathname;
  u.search = '';
  return u.toString();
}

export function isLoopback(serverUrl: string): boolean {
  try {
    const h = new URL(serverUrl).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}
