import os from 'node:os';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface TmuxOptions {
  /** tmux binary. Defaults to "tmux" on PATH. */
  bin?: string;
  /** `-L <name>`: a named server socket (used by tests for isolation). */
  socketName?: string | null;
  /** `-S <path>`: an explicit server socket path. */
  socketPath?: string | null;
}

export interface PaneInfo {
  sessionName: string;
  sessionId: string;
  windowIndex: number;
  paneIndex: number;
  paneId: string;
  panePid: number | null;
  currentCommand: string;
  currentPath: string;
  width: number;
  height: number;
  dead: boolean;
  deadStatus: number | null;
  active: boolean;
  sessionCreated: number;
  attachedClients: number;
  title: string;
  startCommand: string;
}

// Plain ASCII: tmux older than 3.4 escapes control characters in format output, and a tmux
// client without a UTF-8 locale replaces non-ASCII characters.
const SEP = '<|orch|>';
const PANE_FORMAT = [
  '#{session_name}',
  '#{session_id}',
  '#{window_index}',
  '#{pane_index}',
  '#{pane_id}',
  '#{pane_pid}',
  '#{pane_current_command}',
  '#{pane_current_path}',
  '#{pane_width}',
  '#{pane_height}',
  '#{pane_dead}',
  '#{pane_dead_status}',
  '#{pane_active}',
  '#{session_created}',
  '#{session_attached}',
  '#{pane_title}',
  '#{pane_start_command}',
].join(SEP);

/**
 * Run a command in a directory, by changing into it inside the pane. tmux's own `-c` is not enough:
 * a tmux server whose start directory has since been deleted silently ignores it and starts the pane
 * in that dead directory, where programs (Claude Code included) refuse to run.
 */
export function inDirectory(cwd: string, argv: string[]): string[] {
  return ['/bin/sh', '-c', 'cd -- "$0" && exec "$@"', cwd, ...argv];
}

/** Quote a single argument for tmux's command parser (single line only). */
export function tmuxQuote(arg: string): string {
  if (/[\r\n]/.test(arg)) throw new Error('tmuxQuote: argument must not contain newlines');
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export class TmuxError extends Error {
  code: number | null;
  stderr: string;
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.code = code;
    this.stderr = stderr;
  }
}

/** Thin, shell-free wrapper around the tmux CLI. */
/**
 * Text as it may be pasted into somebody's terminal: line breaks and tabs stay, every other control character goes
 * (C0 with ESC among them, DEL, and the C1 range, where an 8-bit CSI lives). A lone carriage return becomes a line
 * break — inside a paste it must not be the key that sends the line.
 */
export function pasteable(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

export class Tmux {
  readonly bin: string;
  readonly socketArgs: string[];

  constructor(opts: TmuxOptions = {}) {
    this.bin = opts.bin ?? 'tmux';
    // -u: always talk UTF-8 to tmux. Services (systemd, launchd) often run without a UTF-8
    // locale, and tmux would then replace every non-ASCII character in captures with "_".
    this.socketArgs = ['-u', ...(opts.socketPath ? ['-S', opts.socketPath] : opts.socketName ? ['-L', opts.socketName] : [])];
  }

  exec(args: string[], opts: { input?: string | Buffer; timeoutMs?: number; cwd?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.bin,
        [...this.socketArgs, ...args],
        // Always from the home directory: the first tmux command starts the tmux server, and a server keeps
        // the directory it was started in for good. If that directory later disappears (an app bundle that
        // is replaced by an update, a temp folder), every new pane starts in a directory that no longer exists.
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 15000, cwd: opts.cwd ?? os.homedir() },
        (err, stdout, stderr) => {
          if (err) {
            const code = typeof (err as any).code === 'number' ? (err as any).code : null;
            reject(new TmuxError(`tmux ${args[0]} failed: ${String(stderr || err.message).trim()}`, code, String(stderr)));
          } else resolve(stdout);
        },
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
  }

  async version(): Promise<string | null> {
    try {
      return (await this.exec(['-V'])).trim().replace(/^tmux\s+/, '');
    } catch {
      return null;
    }
  }

  /** True when a tmux server is running on this socket. */
  async serverRunning(): Promise<boolean> {
    try {
      await this.exec(['list-sessions', '-F', '#{session_name}']);
      return true;
    } catch {
      return false;
    }
  }

  async listPanes(): Promise<PaneInfo[]> {
    let out: string;
    try {
      out = await this.exec(['list-panes', '-a', '-F', PANE_FORMAT]);
    } catch (e) {
      // "no server running" is a normal empty state, not an error.
      if (e instanceof TmuxError && /no server running|No such file|error connecting/i.test(e.stderr + e.message)) return [];
      throw e;
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const f = line.split(SEP);
        return {
          sessionName: f[0]!,
          sessionId: f[1]!,
          windowIndex: Number(f[2]),
          paneIndex: Number(f[3]),
          paneId: f[4]!,
          panePid: f[5] ? Number(f[5]) : null,
          currentCommand: f[6] ?? '',
          currentPath: f[7] ?? '',
          width: Number(f[8]),
          height: Number(f[9]),
          dead: f[10] === '1',
          deadStatus: f[11] ? Number(f[11]) : null,
          active: f[12] === '1',
          sessionCreated: Number(f[13]),
          attachedClients: Number(f[14]),
          title: f[15] ?? '',
          startCommand: f[16] ?? '',
        } satisfies PaneInfo;
      });
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.exec(['has-session', '-t', `=${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates a detached session running `argv` directly (no intermediate shell,
   * so there is nothing to quote). The pane is kept after the process exits so
   * its final output stays inspectable.
   */
  async newSession(opts: {
    name: string;
    cwd: string;
    cols: number;
    rows: number;
    argv: string[];
    env?: Record<string, string>;
  }): Promise<PaneInfo> {
    const args = ['new-session', '-d', '-s', opts.name, '-x', String(opts.cols), '-y', String(opts.rows), '-c', opts.cwd];
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push('-e', `${k}=${v}`);
    args.push('-P', '-F', '#{pane_id}', '--', ...inDirectory(opts.cwd, opts.argv));
    const paneId = (await this.exec(args)).trim();
    await this.exec(['set-option', '-w', '-t', paneId, 'remain-on-exit', 'on']).catch(() => undefined);
    // Keep scrollback generous: the owner inspects history from the office.
    await this.exec(['set-option', '-t', `=${opts.name}`, 'history-limit', '20000']).catch(() => undefined);
    const pane = (await this.listPanes()).find((p) => p.paneId === paneId);
    if (!pane) throw new Error(`tmux session ${opts.name} exited immediately`);
    return pane;
  }

  async killSession(name: string): Promise<void> {
    await this.exec(['kill-session', '-t', `=${name}`]).catch(() => undefined);
  }

  /** Restart the process in an existing (usually dead) pane, keeping the tmux session. */
  async respawnPane(paneId: string, cwd: string, argv: string[], env: Record<string, string> = {}): Promise<void> {
    const args = ['respawn-pane', '-k', '-t', paneId, '-c', cwd];
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push('--', ...inDirectory(cwd, argv));
    await this.exec(args);
  }

  /**
   * Paste text as one bracketed paste, exactly as if the user pasted it. Text only: a paste is closed by an escape
   * sequence (ESC [ 201 ~), and whatever followed one inside the text would arrive as keys pressed — an Escape, a
   * Shift+Tab that changes Claude Code's permission mode, an Enter at a dialog. Messages are written by employees
   * and by people other than the one whose terminal this is; control characters are taken out (see `pasteable`).
   */
  async paste(paneId: string, text: string): Promise<void> {
    const buf = `orch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.exec(['load-buffer', '-b', buf, '-'], { input: pasteable(text) });
    await this.exec(['paste-buffer', '-p', '-d', '-b', buf, '-t', paneId]);
  }

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.exec(['send-keys', '-t', paneId, ...keys]);
  }

  async capture(paneId: string, opts: { ansi?: boolean; historyLines?: number } = {}): Promise<string> {
    const args = ['capture-pane', '-p', '-t', paneId];
    if (opts.ansi) args.push('-e');
    if (opts.historyLines && opts.historyLines > 0) args.push('-S', `-${opts.historyLines}`);
    return this.exec(args);
  }
}

// ───────────────────────── Control mode ──────────────────────────

/** Decode tmux control-mode output escaping (\ooo octal, used for bytes < 32 and backslash). */
export function decodeControlOutput(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  let o = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!;
    if (c === 0x5c && i + 3 < buf.length + 0 && isOct(buf[i + 1]) && isOct(buf[i + 2]) && isOct(buf[i + 3])) {
      out[o++] = ((buf[i + 1]! - 48) << 6) | ((buf[i + 2]! - 48) << 3) | (buf[i + 3]! - 48);
      i += 3;
    } else out[o++] = c;
  }
  return out.subarray(0, o);
}

function isOct(c: number | undefined): boolean {
  return c !== undefined && c >= 48 && c <= 55;
}

interface PendingCommand {
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  cmd: string;
}

export interface ControlClientEvents {
  output: [paneId: string, data: Buffer];
  layout: [windowId: string, layout: string];
  exit: [reason: string];
  paused: [paneId: string];
  notification: [name: string, rest: string];
}

/**
 * A tmux control-mode client (`tmux -C attach`) for one session.
 *
 * This is how Orchestrator observes a pane: tmux itself pushes every byte the
 * pane produces as `%output` notifications, and we send input with send-keys.
 * The Claude Code process is never wrapped, replaced or restarted — we are just
 * one more tmux client.
 */
export class ControlClient extends EventEmitter<ControlClientEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private queue: PendingCommand[] = [];
  private block: { lines: string[]; mine: boolean } | null = null;
  private closed = false;
  private started = false;
  readonly tmux: Tmux;
  readonly sessionName: string;

  constructor(tmux: Tmux, sessionName: string) {
    super();
    this.tmux = tmux;
    this.sessionName = sessionName;
  }

  get alive(): boolean {
    return !!this.child && !this.closed;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.tmux.bin, [...this.tmux.socketArgs, '-C', 'attach-session', '-t', `=${this.sessionName}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: os.homedir(),
      });
      this.child = child;
      let stderr = '';
      let settled = false;
      const ready = () => {
        if (settled) return;
        settled = true;
        this.started = true;
        resolve();
      };
      this.once('notification', ready);
      // Any %begin/%end block also proves the client is attached.
      const onFirst = () => ready();
      this.readyHook = onFirst;
      child.stdout.on('data', (d: Buffer) => this.onData(d));
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.finish(`spawn error: ${err.message}`);
      });
      child.on('exit', (code) => {
        if (!settled) {
          settled = true;
          reject(new Error(`tmux control client exited (${code}): ${stderr.trim()}`));
        }
        this.finish(stderr.trim() || `exit ${code}`);
      });
      // Control clients ignore status lines etc. and do not size the window until asked.
    });
  }

  private readyHook: (() => void) | null = null;

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.queue.splice(0)) p.reject(new Error(`tmux control client closed: ${reason}`));
    this.emit('exit', reason);
  }

  close(): void {
    if (this.closed || !this.child) return;
    try {
      // An empty line detaches a control client cleanly without touching the session.
      this.child.stdin.end('\n');
    } catch {
      /* already gone */
    }
    const child = this.child;
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
    }, 500).unref();
  }

  /** Run a tmux command through the control connection, preserving ordering with output. */
  command(cmd: string): Promise<string[]> {
    if (/[\r\n]/.test(cmd)) return Promise.reject(new Error('control command must be a single line'));
    if (!this.child || this.closed) return Promise.reject(new Error('tmux control client is not running'));
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, cmd });
      this.child!.stdin.write(cmd + '\n');
    });
  }

  /**
   * Run several commands back to back. They are written in a single chunk, so
   * tmux queues them together and no pane output is processed in between —
   * which is what makes a "metadata + capture" pair mutually consistent.
   */
  batch(cmds: string[], onComplete?: () => void): Promise<string[][]> {
    if (cmds.some((c) => /[\r\n]/.test(c))) return Promise.reject(new Error('control command must be a single line'));
    if (!this.child || this.closed) return Promise.reject(new Error('tmux control client is not running'));
    const promises = cmds.map(
      (cmd, i) =>
        new Promise<string[]>((resolve, reject) => {
          this.queue.push({
            // `onComplete` runs synchronously while the final %end line is being parsed — before
            // any later %output in the same chunk — so callers can record exact stream positions.
            resolve: (lines) => {
              if (i === cmds.length - 1) onComplete?.();
              resolve(lines);
            },
            reject,
            cmd,
          });
        }),
    );
    this.child.stdin.write(cmds.join('\n') + '\n');
    return Promise.all(promises);
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const nl = this.buf.indexOf(0x0a, start);
      if (nl === -1) break;
      this.onLine(this.buf.subarray(start, nl));
      start = nl + 1;
    }
    this.buf = start >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(start);
  }

  private onLine(line: Buffer): void {
    if (this.block) {
      if (line[0] === 0x25 /* % */) {
        const s = line.toString('utf8');
        const m = /^%(end|error) \d+ \d+ (\d+)/.exec(s);
        if (m) {
          const block = this.block;
          this.block = null;
          if (block.mine) {
            const pending = this.queue.shift();
            if (pending) {
              if (m[1] === 'end') pending.resolve(block.lines);
              else pending.reject(new Error(`tmux: ${block.lines.join(' ').trim() || 'command failed'} (${pending.cmd.slice(0, 80)})`));
            }
          }
          this.readyHook?.();
          this.readyHook = null;
          return;
        }
      }
      this.block.lines.push(line.toString('utf8'));
      return;
    }
    if (line[0] !== 0x25) return;
    // %output %<pane> <data>
    if (line.length > 8 && line[1] === 0x6f && line.subarray(0, 8).toString('latin1') === '%output ') {
      const sp = line.indexOf(0x20, 8);
      if (sp === -1) return;
      const paneId = line.subarray(8, sp).toString('latin1');
      this.emit('output', paneId, decodeControlOutput(line.subarray(sp + 1)));
      return;
    }
    const s = line.toString('utf8');
    const begin = /^%begin \d+ \d+ (\d+)/.exec(s);
    if (begin) {
      // Flag bit 1 marks a block generated by a command from this client.
      this.block = { lines: [], mine: (Number(begin[1]) & 1) === 1 };
      return;
    }
    const sp = s.indexOf(' ');
    const name = sp === -1 ? s.slice(1) : s.slice(1, sp);
    const rest = sp === -1 ? '' : s.slice(sp + 1);
    if (name === 'extended-output') {
      // %extended-output %<pane> <age> ... : <data>
      const m = /^(%\d+) \d+(?: [^:]*)? : /.exec(rest);
      if (m) {
        const idx = line.indexOf(' : ');
        this.emit('output', m[1]!, decodeControlOutput(line.subarray(idx + 3)));
      }
      return;
    }
    if (name === 'layout-change') {
      const parts = rest.split(' ');
      this.emit('layout', parts[0] ?? '', parts[1] ?? '');
    } else if (name === 'pause') {
      this.emit('paused', rest.trim());
    } else if (name === 'exit') {
      this.finish(rest || 'exit');
      return;
    }
    this.emit('notification', name, rest);
  }
}

/**
 * Convert raw terminal input (what xterm.js produced for a keypress or paste)
 * into tmux send-keys commands. ASCII bytes — including ESC sequences — go
 * through `-H` byte for byte; other characters are sent literally so tmux
 * encodes them as UTF-8.
 */
export function inputToSendKeys(paneId: string, data: string): string[] {
  const cmds: string[] = [];
  let hex: string[] = [];
  let lit = '';
  const flushHex = () => {
    // (By position: taking 256 from the front of one long list, over and over, moves the rest of it each time.)
    for (let at = 0; at < hex.length; at += 256) cmds.push(`send-keys -H -t ${paneId} ${hex.slice(at, at + 256).join(' ')}`);
    hex = [];
  };
  const flushLit = () => {
    if (lit) {
      cmds.push(`send-keys -l -t ${paneId} -- ${tmuxQuote(lit)}`);
      lit = '';
    }
  };
  for (const ch of data) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      flushLit();
      hex.push(cp.toString(16).padStart(2, '0'));
    } else {
      flushHex();
      lit += ch;
    }
  }
  flushHex();
  flushLit();
  return cmds;
}
