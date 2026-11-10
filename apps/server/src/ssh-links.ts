/**
 * SSH links: connect a server you can already `ssh` into as a machine of the office, without
 * opening any port on either side.
 *
 * The office keeps one `ssh` process per server with a reverse tunnel, so that the office's own
 * port appears on the server's loopback interface. The host agent is copied to the server and
 * started there; it reaches the office through that tunnel and enrols like any other machine
 * (single-use token, revocable credential). Everything travels inside SSH, authenticated by the
 * owner's own SSH keys. No password is ever asked for or stored, and an unknown host key is
 * never accepted unless the owner says so.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { newId, nowIso } from '@orchestrator/contracts';
import { EngineError, type Engine } from '@orchestrator/orchestration';

export interface SshProbe {
  os: string;
  arch: string;
  hostname: string;
  user: string;
  home: string;
  node: string | null;
  tmux: string | null;
  claude: string | null;
  git: string | null;
  curl: boolean;
  /** tmux sessions and Claude Code processes already running there (counts only; details come once connected). */
  tmuxSessions: number;
  claudeProcesses: number;
  /** What must be fixed on the server before it can be connected. */
  problems: string[];
  warnings: string[];
}

interface SshLinkRecord {
  id: string;
  /** What the owner typed: `user@host`, `host`, an alias from ~/.ssh/config, optionally `:port`. */
  target: string;
  name: string;
  /** Folders on the server the office may work in. */
  roots: string[];
  /** The port on the server's loopback interface that leads back to the office. */
  remotePort: number;
  hostId: string | null;
  autoConnect: boolean;
  createdAt: string;
}

export interface SshLinkView extends SshLinkRecord {
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  /** What is being done right now, in words. */
  step: string | null;
  error: string | null;
  connectedAt: string | null;
  remote: SshProbe | null;
}

interface Runtime {
  rec: SshLinkRecord;
  status: SshLinkView['status'];
  step: string | null;
  error: string | null;
  connectedAt: string | null;
  remote: SshProbe | null;
  tunnel: ChildProcess | null;
  /** Bumped by every connect/disconnect: an older attempt notices it is no longer wanted. */
  generation: number;
  retry: NodeJS.Timeout | null;
  attempts: number;
  trustNewHost: boolean;
  watching: NodeJS.Timeout | null;
}

const KV = 'sshLinks';
const TARGET = /^(?:([A-Za-z0-9._][A-Za-z0-9._-]{0,63})@)?([A-Za-z0-9][A-Za-z0-9._-]{0,252})(?::(\d{1,5}))?$/;

/** `user@host[:port]`, `host`, `ssh://user@host:port` → what to hand to ssh. Nothing here can be read as an option. */
export function parseTarget(input: string): { dest: string; port: number | null; host: string } {
  const text = input.trim().replace(/^ssh:\/\//i, '').replace(/\/+$/, '');
  const m = TARGET.exec(text);
  if (!m) throw new EngineError('enter the server as user@host (or a name from your ~/.ssh/config), optionally with :port');
  const port = m[3] ? Number(m[3]) : null;
  if (port !== null && (port < 1 || port > 65535)) throw new EngineError('that is not a valid port');
  return { dest: m[1] ? `${m[1]}@${m[2]}` : m[2]!, port, host: m[2]! };
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Non-interactive SSH shells get a bare PATH; node, tmux and claude are usually in one of these. */
const PATH_PRELUDE = `for d in "$HOME/.local/bin" "$HOME/bin" "$HOME/.npm-global/bin" "$HOME/.volta/bin" "$HOME/.bun/bin" "$HOME/.claude/local" "$HOME/.asdf/shims" "$HOME/.local/share/fnm/aliases/default/bin" /usr/local/bin /opt/homebrew/bin /snap/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
ORCH_NVM=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)
[ -n "\${ORCH_NVM:-}" ] && PATH="$ORCH_NVM:$PATH"
export PATH`;

const PROBE = `${PATH_PRELUDE}
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "hostname=$(hostname 2>/dev/null || uname -n)"
echo "user=$(id -un)"
echo "home=$HOME"
echo "node=$(node -v 2>/dev/null || true)"
echo "tmux=$(tmux -V 2>/dev/null || true)"
echo "claude=$(claude --version 2>/dev/null | head -1 || true)"
echo "git=$(git --version 2>/dev/null || true)"
echo "curl=$(command -v curl >/dev/null 2>&1 && echo yes || echo no)"
echo "tmuxSessions=$(tmux list-sessions 2>/dev/null | wc -l | tr -d ' ')"
echo "claudeProcesses=$(ps -u "$(id -u)" -o args= 2>/dev/null | grep -Ec '(^|/)claude( |$)|claude-code/(cli\\.js|bin/claude)' || true)"
`;

/** What ssh said, in words the owner can act on. */
function explain(stderr: string, target: string): string {
  const text = stderr.trim();
  if (/Host key verification failed|No .* host key is known/i.test(text)) return `This computer has never connected to ${target} before, so the server's identity is not known. Connect once in a terminal (ssh ${target}) and accept its key — or confirm here that you trust it — then try again.`;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return `The identity of ${target} is different from the one this computer remembers. That can mean the server was reinstalled, or that something is intercepting the connection. Nothing was sent. Check it in a terminal (ssh ${target}) before trying again.`;
  if (/Permission denied/i.test(text)) return `${target} did not accept any of your SSH keys. Set up key login (ssh-copy-id ${target}) or load your key (ssh-add), check that "ssh ${target}" works in a terminal without asking for a password, then try again. The office never asks for or stores passwords.`;
  if (/Could not resolve hostname/i.test(text)) return `The name "${target}" could not be found. Check the spelling, or use the server's address.`;
  if (/Connection timed out|Operation timed out|timed out/i.test(text)) return `${target} did not answer in time. Check that the server is on and reachable from this computer.`;
  if (/Connection refused/i.test(text)) return `${target} refused the connection: SSH is not listening there (wrong port?).`;
  return text.split('\n').filter(Boolean).slice(-3).join(' ') || 'ssh failed without saying why';
}

export class SshLinks {
  private links = new Map<string, Runtime>();
  private stopped = false;

  private engine: Engine;
  private opts: { hubPort: number; tls: boolean; agentBundle: string | undefined; log: (level: 'info' | 'warn' | 'error', msg: string) => void };

  constructor(engine: Engine, opts: SshLinks['opts']) {
    this.engine = engine;
    this.opts = opts;
    for (const rec of engine.core.store.kvGet<SshLinkRecord[]>(KV, [])) this.links.set(rec.id, this.runtime(rec));
  }

  private runtime(rec: SshLinkRecord): Runtime {
    return { rec, status: 'idle', step: null, error: null, connectedAt: null, remote: null, tunnel: null, generation: 0, retry: null, attempts: 0, trustNewHost: false, watching: null };
  }

  private save(): void {
    this.engine.core.store.kvSet(KV, [...this.links.values()].map((l) => l.rec));
  }

  /** Reconnect the links that were connected when the office last ran. */
  start(): void {
    for (const l of this.links.values()) if (l.rec.autoConnect) this.launch(l);
  }

  stop(): void {
    this.stopped = true;
    for (const l of this.links.values()) this.halt(l);
  }

  list(): SshLinkView[] {
    return [...this.links.values()].map((l) => this.view(l));
  }

  private view(l: Runtime): SshLinkView {
    return { ...l.rec, status: l.status, step: l.step, error: l.error, connectedAt: l.connectedAt, remote: l.remote };
  }

  private require(id: string): Runtime {
    const l = this.links.get(id);
    if (!l) throw new EngineError('unknown SSH link', 404);
    return l;
  }

  // ───────────────────────────── ssh ─────────────────────────────

  private sshArgs(target: string, opts: { trustNewHost?: boolean } = {}): { args: string[]; dest: string } {
    const { dest, port } = parseTarget(target);
    const args: string[] = [];
    // Tests point at their own client configuration; nothing else reads this.
    if (process.env.ORCH_SSH_CONFIG) args.push('-F', process.env.ORCH_SSH_CONFIG);
    args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3');
    if (opts.trustNewHost) args.push('-o', 'StrictHostKeyChecking=accept-new');
    if (port) args.push('-p', String(port));
    return { args, dest };
  }

  /** Run a fixed command on the server, optionally feeding it input. The command never contains anything the owner typed unquoted. */
  private exec(l: Runtime | { target: string; trustNewHost?: boolean }, command: string, input: Buffer | string | null, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
    const { args, dest } = this.sshArgs('rec' in l ? l.rec.target : l.target, { trustNewHost: l.trustNewHost });
    return new Promise((resolve) => {
      const child = execFile('ssh', [...args, dest, command], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : (err as any).killed ? 124 : 255) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: (err as any)?.killed ? `${stderr ?? ''}\ntimed out` : (stderr ?? '') });
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input ?? '');
    });
  }

  private script(l: Runtime | { target: string; trustNewHost?: boolean }, script: string, timeoutMs?: number) {
    return this.exec(l, 'sh -s', script, timeoutMs);
  }

  // ──────────────────────────── probing ───────────────────────────

  /** Look at a server without changing anything on it. */
  async probe(target: string, trustNewHost = false): Promise<SshProbe> {
    const res = await this.script({ target, trustNewHost }, PROBE, 30_000);
    if (res.code !== 0 && !/^os=/m.test(res.stdout)) throw new EngineError(explain(res.stderr, parseTarget(target).dest), 502);
    const kv = new Map(res.stdout.split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()] as const));
    const get = (k: string): string | null => kv.get(k) || null;
    const probe: SshProbe = {
      os: get('os') ?? 'unknown',
      arch: get('arch') ?? 'unknown',
      hostname: get('hostname') ?? parseTarget(target).host,
      user: get('user') ?? '',
      home: get('home') ?? '',
      node: get('node'),
      tmux: get('tmux'),
      claude: get('claude'),
      git: get('git'),
      curl: get('curl') === 'yes',
      tmuxSessions: Number(get('tmuxSessions') ?? 0) || 0,
      claudeProcesses: Number(get('claudeProcesses') ?? 0) || 0,
      problems: [],
      warnings: [],
    };
    if (!/^(Linux|Darwin)$/.test(probe.os)) probe.problems.push(`The server runs ${probe.os}; employees need Linux or macOS (on Windows, use WSL2).`);
    const [major, minor] = (probe.node ?? '').replace(/^v/, '').split('.').map(Number);
    if (!probe.node) probe.problems.push('Node.js is not installed on the server (22.18 or newer is needed to run the agent).');
    else if (!(major! > 22 || (major === 22 && minor! >= 18))) probe.problems.push(`Node.js ${probe.node} is too old on the server; 22.18 or newer is needed.`);
    if (!probe.tmux) probe.problems.push('tmux is not installed on the server; employees run inside tmux sessions.');
    if (!probe.curl) probe.problems.push('curl is not installed on the server; Claude Code hooks use it to report to the agent.');
    if (!probe.claude) probe.warnings.push('The claude CLI was not found on the server. Install Claude Code there (and log in once) before starting employees.');
    if (!probe.git) probe.warnings.push('git is not installed on the server; employees need it to work in repositories.');
    return probe;
  }

  // ─────────────────────────── lifecycle ──────────────────────────

  /** Add a server and start connecting it. Returns at once; progress is in the link's `status` and `step`. */
  add(input: { target: string; name?: string; roots?: string[]; trustNewHost?: boolean }, actor = 'owner'): SshLinkView {
    if (this.opts.tls) throw new EngineError('this office is served over TLS; a server can connect to it directly (Machines → Connect a machine) and does not need an SSH link');
    const { dest, host } = parseTarget(input.target);
    const target = input.target.trim().replace(/^ssh:\/\//i, '');
    if ([...this.links.values()].some((l) => l.rec.target === target)) throw new EngineError(`${dest} is already linked`);
    const roots = (input.roots ?? []).map((r) => r.trim()).filter(Boolean);
    for (const r of roots) if (!/^(\/|~\/)[A-Za-z0-9._ \/@+-]*$/.test(r) || r.includes('..')) throw new EngineError(`"${r}" is not a folder path the office can use (absolute paths only)`);
    const rec: SshLinkRecord = {
      id: newId(),
      target,
      name: (input.name ?? '').trim().slice(0, 60) || host.split('.')[0]!,
      roots,
      remotePort: 20000 + crypto.randomInt(25000),
      hostId: null,
      autoConnect: true,
      createdAt: nowIso(),
    };
    const l = this.runtime(rec);
    l.trustNewHost = input.trustNewHost === true;
    this.links.set(rec.id, l);
    this.save();
    this.engine.core.audit(actor, 'ssh_link.created', rec.id, { target: dest, name: rec.name, roots, trustedNewHostKey: l.trustNewHost });
    this.launch(l);
    return this.view(l);
  }

  connect(id: string, opts: { trustNewHost?: boolean } = {}): SshLinkView {
    const l = this.require(id);
    if (opts.trustNewHost) l.trustNewHost = true;
    l.rec.autoConnect = true;
    this.save();
    this.launch(l);
    return this.view(l);
  }

  /** Close the tunnel. The agent and every session keep running on the server; they reappear on the next connect. */
  disconnect(id: string, actor = 'owner'): SshLinkView {
    const l = this.require(id);
    this.halt(l);
    l.rec.autoConnect = false;
    l.status = 'idle';
    l.step = null;
    l.error = null;
    this.save();
    this.engine.core.audit(actor, 'ssh_link.disconnected', id, { target: l.rec.target });
    return this.view(l);
  }

  /** Remove the link: stop the agent on the server, delete what was installed for this link, and revoke the machine's credential. */
  async remove(id: string, actor = 'owner'): Promise<{ ok: true; cleaned: boolean }> {
    const l = this.require(id);
    this.halt(l);
    const res = await this.script(l, `${PATH_PRELUDE}
export ORCH_AGENT_HOME="$HOME/.orchestrator/links/${l.rec.id}"
PID=$(cat "$ORCH_AGENT_HOME/agent.pid" 2>/dev/null || true)
"$HOME/.orchestrator/bin/orchestrator-agent" stop >/dev/null 2>&1 || true
# The agent writes its state as it stops: wait until it is really gone before removing its folder.
i=0; while [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && [ $i -lt 40 ]; do sleep 0.25; i=$((i+1)); done
[ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && kill "$PID" 2>/dev/null || true
rm -rf "$ORCH_AGENT_HOME"
[ -e "$ORCH_AGENT_HOME" ] || echo ORCH:CLEANED
`, 30_000).catch(() => null);
    if (l.rec.hostId && this.engine.core.hosts.get(l.rec.hostId)) this.engine.hosts.revoke(l.rec.hostId, actor);
    this.links.delete(id);
    this.save();
    const cleaned = !!res && /ORCH:CLEANED/.test(res.stdout);
    this.engine.core.audit(actor, 'ssh_link.removed', id, { target: l.rec.target, hostId: l.rec.hostId, cleanedOnServer: cleaned });
    return { ok: true, cleaned };
  }

  private halt(l: Runtime): void {
    l.generation++;
    if (l.retry) clearTimeout(l.retry);
    if (l.watching) clearInterval(l.watching);
    l.retry = null;
    l.watching = null;
    const t = l.tunnel;
    l.tunnel = null;
    if (t && t.exitCode === null) t.kill('SIGTERM');
  }

  private launch(l: Runtime): void {
    this.halt(l);
    const generation = l.generation;
    l.status = l.connectedAt ? 'reconnecting' : 'connecting';
    l.error = null;
    void this.connectOnce(l, generation).catch((e) => {
      if (generation !== l.generation || this.stopped) return;
      const t = l.tunnel;
      l.tunnel = null;
      if (t && t.exitCode === null) t.kill('SIGTERM');
      l.status = 'error';
      l.step = null;
      l.error = (e as Error).message;
      this.opts.log('warn', `SSH link ${l.rec.target}: ${l.error}`);
      // Something that was working and broke (the network, a reboot) is retried; a first attempt that fails waits for the owner.
      if (l.connectedAt) this.retryLater(l);
    });
  }

  private retryLater(l: Runtime): void {
    if (this.stopped || !l.rec.autoConnect) return;
    const delay = Math.min(60_000, 3000 * 2 ** Math.min(l.attempts++, 5));
    const generation = l.generation;
    l.retry = setTimeout(() => {
      if (generation === l.generation) this.launch(l);
    }, delay);
    l.retry.unref();
  }

  private async connectOnce(l: Runtime, generation: number): Promise<void> {
    const live = () => generation === l.generation && !this.stopped;
    const step = (text: string) => {
      if (live()) l.step = text;
    };
    const dest = parseTarget(l.rec.target).dest;
    if (!this.opts.agentBundle) throw new Error('the host agent has not been built on this computer (run: pnpm build)');

    step('Checking the server');
    const probe = await this.probe(l.rec.target, l.trustNewHost);
    if (!live()) return;
    l.remote = probe;
    if (probe.problems.length) throw new Error(probe.problems.join(' '));

    step('Installing the agent');
    const bundle = fs.readFileSync(this.opts.agentBundle);
    const sha = crypto.createHash('sha256').update(bundle).digest('hex');
    const have = await this.script(l, `f="$HOME/.orchestrator/bin/orchestrator-agent.mjs"; if [ -f "$f" ]; then (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d' ' -f1; fi`);
    const fresh = have.stdout.trim() !== sha;
    if (fresh) {
      const up = await this.exec(l, `sh -c 'umask 077; mkdir -p "$HOME/.orchestrator/bin" && cat > "$HOME/.orchestrator/bin/orchestrator-agent.mjs.new" && mv "$HOME/.orchestrator/bin/orchestrator-agent.mjs.new" "$HOME/.orchestrator/bin/orchestrator-agent.mjs"'`, bundle, 120_000);
      if (up.code !== 0) throw new Error(`could not copy the agent to ${dest}: ${explain(up.stderr, dest)}`);
    }
    const wrapper = await this.script(
      l,
      `set -eu\numask 077\nmkdir -p "$HOME/.orchestrator/bin" "$HOME/.orchestrator/links/${l.rec.id}"\ncat > "$HOME/.orchestrator/bin/orchestrator-agent" <<'ORCH_WRAPPER'\n#!/bin/sh\n${PATH_PRELUDE}\nexec node "$HOME/.orchestrator/bin/orchestrator-agent.mjs" "$@"\nORCH_WRAPPER\nchmod 700 "$HOME/.orchestrator/bin/orchestrator-agent"\n`,
    );
    if (wrapper.code !== 0) throw new Error(`could not prepare the agent on ${dest}: ${explain(wrapper.stderr, dest)}`);
    if (!live()) return;

    step('Opening the tunnel');
    await this.openTunnel(l, generation);
    if (!live()) return;

    step('Starting the agent');
    const hostId = await this.ensureAgent(l, fresh);
    if (!live()) return;
    if (hostId !== l.rec.hostId) {
      // A server whose agent folder was wiped enrols again: the machine it used to be is no longer valid.
      if (l.rec.hostId && this.engine.core.hosts.get(l.rec.hostId)) this.engine.hosts.revoke(l.rec.hostId, 'system');
      l.rec.hostId = hostId;
      this.save();
    }

    step('Waiting for the server to come online');
    const online = async (seconds: number) => {
      for (let i = 0; i < seconds * 4 && live() && !this.engine.core.agents.isOnline(hostId); i++) await new Promise((r) => setTimeout(r, 250));
      return this.engine.core.agents.isOnline(hostId);
    };
    // An agent that was already running finds the new tunnel by itself within its own retry interval;
    // if it does not, it is restarted (its sessions live in tmux and are not touched by that).
    if (!(await online(30)) && live()) {
      step('Restarting the agent on the server');
      await this.ensureAgent(l, true);
      await online(25);
    }
    if (!live()) return;
    if (!this.engine.core.agents.isOnline(hostId)) {
      const log = await this.script(l, `tail -n 6 "$HOME/.orchestrator/links/${l.rec.id}/agent.log" 2>/dev/null || true`, 20_000);
      throw new Error(`the agent on ${dest} did not come online. Its last words: ${log.stdout.trim().split('\n').slice(-3).join(' | ') || '(nothing logged)'}`);
    }
    l.status = 'connected';
    l.step = null;
    l.error = null;
    l.attempts = 0;
    const first = !l.connectedAt;
    l.connectedAt = nowIso();
    this.engine.core.audit('system', first ? 'ssh_link.connected' : 'ssh_link.reconnected', l.rec.id, { target: dest, hostId, remotePort: l.rec.remotePort });
    this.opts.log('info', `SSH link ${dest} is up (host ${hostId}, remote port ${l.rec.remotePort})`);
  }

  /** Start `ssh -N -R …` and make sure the office really answers on the server's side of it. */
  private async openTunnel(l: Runtime, generation: number): Promise<void> {
    const dest = parseTarget(l.rec.target).dest;
    for (let attempt = 0; attempt < 6; attempt++) {
      const { args } = this.sshArgs(l.rec.target, { trustNewHost: l.trustNewHost });
      const child = spawn('ssh', [...args, '-o', 'ExitOnForwardFailure=yes', '-N', '-R', `127.0.0.1:${l.rec.remotePort}:127.0.0.1:${this.opts.hubPort}`, dest], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr!.on('data', (d) => (stderr = (stderr + String(d)).slice(-2000)));
      const exited = new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? 255)));
      // Up when the office answers through it; down when ssh gives up first.
      let up = false;
      for (let i = 0; i < 40 && child.exitCode === null && generation === l.generation; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (child.exitCode !== null) break;
        const ping = await this.script(l, `${PATH_PRELUDE}\nnode -e "fetch('http://127.0.0.1:${l.rec.remotePort}/healthz').then(async (r) => { const j = await r.json(); process.exit(r.ok && j.name === 'orchestrator' ? 0 : 1); }, () => process.exit(1))"`, 20_000);
        if (ping.code === 0) {
          up = true;
          break;
        }
      }
      if (generation !== l.generation) {
        if (child.exitCode === null) child.kill('SIGTERM');
        return;
      }
      if (up) {
        l.tunnel = child;
        void exited.then(() => {
          if (l.tunnel !== child) return; // closed on purpose
          l.tunnel = null;
          l.status = 'reconnecting';
          l.step = 'The connection dropped; reconnecting';
          this.opts.log('warn', `SSH link ${dest}: tunnel closed (${stderr.trim().split('\n').pop() ?? 'no reason given'})`);
          this.retryLater(l);
        });
        return;
      }
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
      // Someone else on the server uses that port: take another one and remember it.
      if (/remote port forwarding failed|Address already in use/i.test(stderr) || !stderr.trim()) {
        l.rec.remotePort = 20000 + crypto.randomInt(25000);
        this.save();
        continue;
      }
      throw new Error(explain(stderr, dest));
    }
    throw new Error(`could not open a tunnel to ${dest}: no free port was found on the server`);
  }

  /** Make sure the agent on the server is enrolled with this office and running against the tunnel. Returns its host id. */
  private async ensureAgent(l: Runtime, restart: boolean): Promise<string> {
    const dest = parseTarget(l.rec.target).dest;
    const run = (token: string | null) =>
      this.script(
        l,
        `set -eu
${PATH_PRELUDE}
export ORCH_AGENT_HOME="$HOME/.orchestrator/links/${l.rec.id}"
A="$HOME/.orchestrator/bin/orchestrator-agent"
URL="http://127.0.0.1:${l.rec.remotePort}"
NAME=${shq(l.rec.name)}
TOKEN=${shq(token ?? '')}
CFG="$ORCH_AGENT_HOME/config.json"
enrolled() { [ -f "$CFG" ] && node -e "const c=require(process.argv[1]); process.exit(c.credential && c.hostId ? 0 : 1)" "$CFG"; }
if ! enrolled; then
  [ -n "$TOKEN" ] || { echo "ORCH:NEED_TOKEN"; exit 0; }
  ORCH_ENROLLMENT_TOKEN="$TOKEN" "$A" login --server "$URL" --name "$NAME"${l.rec.roots.map((r) => ` --allow-root ${r.startsWith('~/') ? `"$HOME"/${shq(r.slice(2))}` : shq(r)}`).join('')} >/dev/null
fi
running() { [ -f "$ORCH_AGENT_HOME/agent.pid" ] && kill -0 "$(cat "$ORCH_AGENT_HOME/agent.pid")" 2>/dev/null; }
same() { node -e "const c=require(process.argv[1]); process.exit(c.serverUrl === process.argv[2] ? 0 : 1)" "$CFG" "$URL"; }
if running && { [ ${restart ? '1' : '0'} = 1 ] || ! same; }; then "$A" stop >/dev/null 2>&1 || true; sleep 1; fi
if ! running; then "$A" connect --daemon --server "$URL"${l.rec.roots.map((r) => ` --allow-root ${r.startsWith('~/') ? `"$HOME"/${shq(r.slice(2))}` : shq(r)}`).join('')} >/dev/null; fi
echo "ORCH:HOST=$(node -e "console.log(require(process.argv[1]).hostId)" "$CFG")"
`,
        60_000,
      );
    let res = await run(null);
    let enrolledSince: number | null = null;
    if (/ORCH:NEED_TOKEN/.test(res.stdout)) {
      enrolledSince = Date.now();
      const { token } = this.engine.hosts.createEnrollmentToken(`ssh:${dest}`, 10 * 60_000, 'owner');
      res = await run(token);
    }
    const hostId = /ORCH:HOST=([0-9a-f-]{8,})/.exec(res.stdout)?.[1];
    if (!hostId) throw new Error(`could not start the agent on ${dest}: ${(res.stderr.trim() || res.stdout.trim()).split('\n').slice(-3).join(' | ') || 'no output'}`);
    // The id comes from the server's own output, so it is not taken on trust: it must be the machine this
    // link already had, or one that enrolled just now with the token issued here. A server cannot point
    // its link at somebody else's machine (and so get that one revoked when the link is removed).
    const host = this.engine.core.hosts.get(hostId);
    const mine = hostId === l.rec.hostId || (enrolledSince !== null && !!host && Date.parse(host.enrolledAt) >= enrolledSince - 2000 && host.id !== l.rec.hostId);
    if (!host || !mine) throw new Error(`${dest} reported a machine that does not belong to this link; nothing was changed`);
    return hostId;
  }
}
