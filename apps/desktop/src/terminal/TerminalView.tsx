import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { connection } from '../lib/api.ts';
import { onTerminal, useOffice } from '../lib/store.ts';

interface Props {
  sessionId: string;
  /** Read-only tiles (terminal wall) never take keyboard focus. */
  interactive?: boolean;
  /** While controlling, resize the real pane to fit this panel. */
  fitPane?: boolean;
  className?: string;
  onClosed?: (reason: string) => void;
}

const THEME = {
  background: '#0b0f17',
  foreground: '#d7dde8',
  cursor: '#7fb0ff',
  cursorAccent: '#0b0f17',
  selectionBackground: '#2b4a7a',
  black: '#1b2230',
  red: '#ff6b7d',
  green: '#6fd08c',
  yellow: '#f0c36a',
  blue: '#6ea8ff',
  magenta: '#c792ea',
  cyan: '#5fd3d0',
  white: '#d7dde8',
  brightBlack: '#5b6677',
  brightRed: '#ff8a98',
  brightGreen: '#8ee6a6',
  brightYellow: '#ffd98a',
  brightBlue: '#8fbcff',
  brightMagenta: '#dab0ff',
  brightCyan: '#86e6e3',
  brightWhite: '#ffffff',
};

/**
 * A real terminal bound to an employee's tmux pane.
 *
 * The server sends a byte-exact snapshot followed by the live output stream.
 * Output is numbered; chunks at or before the snapshot are already in it and
 * are dropped, chunks that overtook the snapshot are replayed after it.
 * Keystrokes are only sent while this client holds control — and the server
 * enforces that regardless of what this component does.
 */
export function TerminalView({ sessionId, interactive = true, fitPane = false, className, onClosed }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const paneSize = useRef({ cols: 120, rows: 34 });
  const [closed, setClosed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const controlling = useOffice((s) => s.control[sessionId]?.you === true);
  const controllingRef = useRef(controlling);
  controllingRef.current = controlling;
  const fitPaneRef = useRef(fitPane);
  fitPaneRef.current = fitPane;

  useEffect(() => {
    const host = hostRef.current!;
    const term = new Terminal({
      theme: THEME,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: false,
      disableStdin: !interactive,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    let snapshotSeq = -1;
    const recent: Array<{ seq: number; data: Uint8Array }> = [];

    /** Scale the font so the pane's exact cols×rows fit the panel (no reflow: tmux owns the size). */
    const scaleToPane = () => {
      const { cols, rows } = paneSize.current;
      const w = host.clientWidth - 8;
      const h = host.clientHeight - 4;
      if (w <= 0 || h <= 0) return;
      const size = Math.max(6, Math.min(16, Math.floor(Math.min(w / (cols * 0.602), h / (rows * 1.15)) * 10) / 10));
      if (term.options.fontSize !== size) term.options.fontSize = size;
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    };

    /** While the owner is in control they may prefer the pane to fill the panel. */
    const fitPaneToPanel = () => {
      if (!controllingRef.current || !fitPaneRef.current) return scaleToPane();
      term.options.fontSize = 13;
      const dims = fit.proposeDimensions();
      if (!dims || !dims.cols || !dims.rows) return;
      if (dims.cols !== paneSize.current.cols || dims.rows !== paneSize.current.rows) {
        connection.send({ t: 'term.resize', sessionId, cols: dims.cols, rows: dims.rows });
      }
    };

    const off = onTerminal(sessionId, (e) => {
      if (e.t === 'snapshot') {
        paneSize.current = { cols: e.cols, rows: e.rows };
        snapshotSeq = e.seq;
        term.reset();
        scaleToPane();
        term.write(e.data);
        for (const chunk of recent) if (chunk.seq > snapshotSeq) term.write(chunk.data);
        setLoading(false);
        setClosed(null);
      } else if (e.t === 'output') {
        recent.push({ seq: e.seq, data: e.data });
        if (recent.length > 600) recent.splice(0, recent.length - 600);
        if (snapshotSeq >= 0 && e.seq > snapshotSeq) term.write(e.data);
      } else {
        setClosed(e.reason);
        onClosed?.(e.reason);
      }
    });

    const dataSub = term.onData((data) => {
      // Observers never send input. (The server would drop it anyway.)
      if (interactive && controllingRef.current) connection.send({ t: 'term.input', sessionId, data });
    });

    const ro = new ResizeObserver(() => fitPaneToPanel());
    ro.observe(host);
    connection.send({ t: 'term.open', sessionId });

    return () => {
      ro.disconnect();
      dataSub.dispose();
      off();
      connection.send({ t: 'term.close', sessionId });
      termRef.current = null;
      // xterm still has a repaint queued for what was written last; disposing under it throws
      // ("reading 'dimensions'"). Let that settle, then dispose.
      term.write('', () => window.setTimeout(() => term.dispose(), 150));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, interactive]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.cursorBlink = controlling;
    if (controlling && interactive) term.focus();
    else term.blur();
  }, [controlling, interactive]);

  return (
    <div className={`term ${controlling ? 'term-controlled' : ''} ${className ?? ''}`}>
      <div ref={hostRef} className="term-host" />
      {loading && !closed && <div className="term-overlay">Connecting to the real terminal…</div>}
      {closed && <div className="term-overlay term-overlay-closed">Terminal unavailable: {closed}</div>}
    </div>
  );
}
