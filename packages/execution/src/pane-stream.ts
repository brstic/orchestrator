import { EventEmitter } from 'node:events';
import type { TerminalScreen } from '@orchestrator/contracts';
import { ControlClient, inputToSendKeys, tmuxQuote, type Tmux } from './tmux.ts';

const META_FORMAT = [
  '#{pane_width}',
  '#{pane_height}',
  '#{cursor_x}',
  '#{cursor_y}',
  '#{alternate_on}',
  '#{cursor_flag}',
  '#{keypad_cursor_flag}',
  '#{keypad_flag}',
  '#{mouse_standard_flag}',
  '#{mouse_button_flag}',
  '#{mouse_any_flag}',
  '#{mouse_sgr_flag}',
  '#{bracket_paste_flag}',
  '#{scroll_region_upper}',
  '#{scroll_region_lower}',
  '#{history_size}',
  '#{pane_dead}',
].join(',');

interface PaneMeta {
  cols: number;
  rows: number;
  cx: number;
  cy: number;
  alt: boolean;
  cursorVisible: boolean;
  appCursor: boolean;
  appKeypad: boolean;
  mouseStd: boolean;
  mouseBtn: boolean;
  mouseAny: boolean;
  mouseSgr: boolean;
  bracketedPaste: boolean;
  scrollTop: number;
  scrollBottom: number;
  history: number;
  dead: boolean;
}

function parseMeta(line: string): PaneMeta {
  const f = line.split(',').map((x) => Number(x) || 0);
  return {
    cols: f[0]!,
    rows: f[1]!,
    cx: f[2]!,
    cy: f[3]!,
    alt: f[4] === 1,
    cursorVisible: f[5] === 1,
    appCursor: f[6] === 1,
    appKeypad: f[7] === 1,
    mouseStd: f[8] === 1,
    mouseBtn: f[9] === 1,
    mouseAny: f[10] === 1,
    mouseSgr: f[11] === 1,
    bracketedPaste: f[12] === 1,
    scrollTop: f[13]!,
    scrollBottom: f[14]!,
    history: f[15]!,
    dead: f[16] === 1,
  };
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export interface PaneSnapshot {
  cols: number;
  rows: number;
  data: Buffer;
  seq: number;
}

export interface PaneStreamEvents {
  /** Raw bytes produced by the pane, in order. `seq` increases by one per chunk. */
  output: [seq: number, data: Buffer];
  screen: [screen: TerminalScreen];
  resize: [cols: number, rows: number];
  /** The stream had to reattach; viewers must take a fresh snapshot. */
  resync: [];
  closed: [reason: string];
}

/**
 * Live view of one tmux pane: ordered output stream, consistent snapshots for
 * late joiners, low-rate screen captures for in-world monitors, and input.
 */
export class PaneStream extends EventEmitter<PaneStreamEvents> {
  readonly tmux: Tmux;
  readonly sessionName: string;
  paneId: string;
  cols = 0;
  rows = 0;
  /**
   * Position in the output stream. It starts from the clock rather than zero so
   * that it keeps increasing when the host agent restarts: a viewer that was
   * already watching must never mistake new output for output it has seen.
   */
  seq = Date.now() * 1000;
  private client: ControlClient | null = null;
  private closed = false;
  private reconnecting = false;
  private screenTimer: NodeJS.Timeout | null = null;
  private lastScreenAt = 0;
  private lastScreenHash = '';
  private dirty = true;
  /** Minimum gap between monitor captures, in ms. */
  screenIntervalMs: number;
  /** Serialises input so keystrokes and pastes keep their order. */
  private inputChain: Promise<void> = Promise.resolve();

  constructor(tmux: Tmux, sessionName: string, paneId: string, opts: { screenIntervalMs?: number } = {}) {
    super();
    this.tmux = tmux;
    this.sessionName = sessionName;
    this.paneId = paneId;
    this.screenIntervalMs = opts.screenIntervalMs ?? 1000;
  }

  get connected(): boolean {
    return !!this.client?.alive;
  }

  async open(): Promise<void> {
    await this.connect();
    this.scheduleScreen(0);
  }

  private async connect(): Promise<void> {
    const client = new ControlClient(this.tmux, this.sessionName);
    client.on('output', (paneId, data) => {
      if (paneId !== this.paneId) return;
      this.seq++;
      this.dirty = true;
      this.emit('output', this.seq, data);
      this.scheduleScreen();
    });
    client.on('layout', () => {
      void this.refreshSize();
    });
    client.on('exit', (reason) => {
      if (this.client !== client) return;
      this.client = null;
      if (this.closed) return;
      void this.reconnect(reason);
    });
    await client.start();
    this.client = client;
    await this.refreshSize(true);
  }

  private async reconnect(reason: string): Promise<void> {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    try {
      for (let attempt = 0; attempt < 5 && !this.closed; attempt++) {
        await new Promise((r) => setTimeout(r, 200 + attempt * 300));
        if (!(await this.tmux.hasSession(this.sessionName))) {
          this.finish(`tmux session ended (${reason})`);
          return;
        }
        try {
          await this.connect();
          this.dirty = true;
          this.emit('resync');
          this.scheduleScreen(0);
          return;
        } catch {
          /* retry */
        }
      }
      this.finish(`could not reattach to tmux session (${reason})`);
    } finally {
      this.reconnecting = false;
    }
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.screenTimer) clearTimeout(this.screenTimer);
    this.emit('closed', reason);
  }

  /** Detach our control client. The tmux session and its process keep running. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.screenTimer) clearTimeout(this.screenTimer);
    this.client?.close();
    this.client = null;
  }

  private requireClient(): ControlClient {
    if (!this.client || !this.client.alive) throw new Error('terminal stream is not connected');
    return this.client;
  }

  private async meta(): Promise<PaneMeta> {
    const lines = await this.requireClient().command(`display-message -p -t ${this.paneId} ${tmuxQuote(META_FORMAT)}`);
    return parseMeta(lines[0] ?? '');
  }

  private async refreshSize(silent = false): Promise<void> {
    try {
      const m = await this.meta();
      if (m.cols && m.rows && (m.cols !== this.cols || m.rows !== this.rows)) {
        this.cols = m.cols;
        this.rows = m.rows;
        this.dirty = true;
        if (!silent) {
          this.emit('resize', m.cols, m.rows);
          this.scheduleScreen(0);
        }
      }
    } catch {
      /* pane went away; the exit path handles it */
    }
  }

  /**
   * A byte-exact starting point for a terminal emulator: scrollback, the
   * visible screen, terminal modes and cursor position. Because the capture
   * runs through the control connection it is ordered against `%output`, so
   * `seq` tells the viewer precisely which output chunks to apply afterwards.
   */
  async snapshot(historyLines = 2000): Promise<PaneSnapshot> {
    const client = this.requireClient();
    let alt = (await this.meta()).alt;
    for (let attempt = 0; ; attempt++) {
      const start = alt ? '0' : `-${historyLines}`;
      // The stream position must be read at the instant the capture completes, not after this
      // function resumes: output that arrives in between is not part of the capture.
      let seq = this.seq;
      const [metaLines, body] = await client.batch(
        [`display-message -p -t ${this.paneId} ${tmuxQuote(META_FORMAT)}`, `capture-pane -p -e -t ${this.paneId} -S ${start}`],
        () => {
          seq = this.seq;
        },
      );
      const m = parseMeta(metaLines![0] ?? '');
      if (m.alt !== alt && attempt < 2) {
        alt = m.alt;
        continue;
      }
      this.cols = m.cols || this.cols;
      this.rows = m.rows || this.rows;
      let out = '';
      if (m.alt) out += '\x1b[?1049h\x1b[H';
      out += body!.map((l) => l + '\x1b[0m').join('\r\n');
      if (m.scrollTop !== 0 || (m.scrollBottom !== 0 && m.scrollBottom !== m.rows - 1)) out += `\x1b[${m.scrollTop + 1};${m.scrollBottom + 1}r`;
      if (m.appCursor) out += '\x1b[?1h';
      if (m.appKeypad) out += '\x1b=';
      if (m.mouseStd) out += '\x1b[?1000h';
      if (m.mouseBtn) out += '\x1b[?1002h';
      if (m.mouseAny) out += '\x1b[?1003h';
      if (m.mouseSgr) out += '\x1b[?1006h';
      if (m.bracketedPaste) out += '\x1b[?2004h';
      out += `\x1b[${m.cy + 1};${m.cx + 1}H`;
      out += m.cursorVisible ? '\x1b[?25h' : '\x1b[?25l';
      return { cols: this.cols, rows: this.rows, data: Buffer.from(out, 'utf8'), seq };
    }
  }

  /** Capture the visible screen for a monitor texture. */
  async screen(): Promise<TerminalScreen> {
    const [metaLines, captured] = await this.requireClient().batch([
      `display-message -p -t ${this.paneId} ${tmuxQuote(META_FORMAT)}`,
      `capture-pane -p -e -t ${this.paneId}`,
    ]);
    const m = parseMeta(metaLines![0] ?? '');
    const body = captured!.slice(0, m.rows || captured!.length);
    return {
      cols: m.cols,
      rows: m.rows,
      lines: body,
      cursor: { x: m.cx, y: m.cy, visible: m.cursorVisible },
      ts: new Date().toISOString(),
      hash: fnv1a(body.join('\n') + `|${m.cx},${m.cy}`),
    };
  }

  private scheduleScreen(delay?: number): void {
    if (this.closed || this.screenTimer) return;
    const wait = delay ?? Math.max(150, this.screenIntervalMs - (Date.now() - this.lastScreenAt));
    this.screenTimer = setTimeout(() => {
      this.screenTimer = null;
      if (this.closed || !this.dirty || !this.connected) return;
      this.dirty = false;
      this.lastScreenAt = Date.now();
      this.screen()
        .then((s) => {
          if (s.hash !== this.lastScreenHash) {
            this.lastScreenHash = s.hash;
            this.emit('screen', s);
          }
          if (this.dirty) this.scheduleScreen();
        })
        .catch(() => undefined);
    }, wait);
    this.screenTimer.unref?.();
  }

  /** Force a fresh monitor capture (e.g. right after a viewer connects). */
  requestScreen(): void {
    this.dirty = true;
    this.lastScreenHash = '';
    this.scheduleScreen(0);
  }

  /** Send raw terminal input bytes to the pane (keystrokes from xterm.js). */
  input(data: string): Promise<void> {
    const run = async () => {
      const client = this.requireClient();
      for (const cmd of inputToSendKeys(this.paneId, data)) await client.command(cmd);
    };
    const p = this.inputChain.then(run, run);
    this.inputChain = p.catch(() => undefined);
    return p;
  }

  /** Paste text as a single bracketed paste and optionally press Enter. */
  paste(text: string, submit: boolean): Promise<void> {
    const run = async () => {
      this.requireClient();
      await this.tmux.paste(this.paneId, text);
      if (submit) {
        // Give the TUI a beat to ingest the paste before Enter arrives.
        await new Promise((r) => setTimeout(r, 180));
        await this.requireClient().command(`send-keys -t ${this.paneId} Enter`);
      }
    };
    const p = this.inputChain.then(run, run);
    this.inputChain = p.catch(() => undefined);
    return p;
  }

  keys(keys: string[]): Promise<void> {
    const run = async () => {
      const client = this.requireClient();
      for (const k of keys) {
        if (!/^[A-Za-z0-9-]+$/.test(k)) throw new Error(`invalid key name: ${k}`);
        await client.command(`send-keys -t ${this.paneId} ${k}`);
      }
    };
    const p = this.inputChain.then(run, run);
    this.inputChain = p.catch(() => undefined);
    return p;
  }

  async resize(cols: number, rows: number): Promise<void> {
    const c = Math.max(20, Math.min(400, Math.floor(cols)));
    const r = Math.max(5, Math.min(200, Math.floor(rows)));
    await this.requireClient().command(`refresh-client -C ${c}x${r}`);
    await this.refreshSize();
  }

  async history(lines: number): Promise<string> {
    return this.tmux.capture(this.paneId, { historyLines: Math.max(1, Math.min(20000, lines)) });
  }
}
