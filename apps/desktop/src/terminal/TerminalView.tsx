import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { connection } from '../lib/api.ts';
import { onTerminal, useOffice } from '../lib/store.ts';
import { copyText, selectionText } from './clipboard.ts';

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
  /** Something is selected in this terminal: the Copy button is shown. */
  const [selected, setSelected] = useState(false);
  const copyRef = useRef<() => void>(() => undefined);
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

    // ── copying out of the terminal, and pasting into it ──
    // A terminal has no copy of its own in a window: Ctrl+C is the program's interrupt, and Electron has no menu on
    // the right button. So: with something selected, Ctrl/Cmd+C (or Ctrl+Shift+C), the right button and the Copy
    // button copy it — for whoever watches as well as for whoever holds the keyboard. Nothing is copied by selecting alone.
    const copySelection = () => {
      const text = selectionText(term.getSelection());
      if (!text) return;
      void copyText(text).then((ok) => useOffice.getState().toast(ok ? 'Copied' : 'Could not copy: the clipboard refused it', ok ? 'success' : 'error'));
    };
    copyRef.current = copySelection;
    /** Pasting is typing: only into a terminal one holds the keyboard of. */
    const pasteClipboard = () => {
      if (!interactive || !controllingRef.current) return;
      void navigator.clipboard
        .readText()
        .then((text) => text && term.paste(text))
        .catch(() => useOffice.getState().toast('The clipboard cannot be read from here: press Ctrl+V to paste', 'info'));
    };
    const selectionSub = term.onSelectionChange(() => setSelected(term.hasSelection()));
    // On the window, before the terminal sees the key: with a selection, Ctrl+C must not reach the program as an interrupt.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'c' && term.hasSelection()) {
        e.preventDefault();
        e.stopPropagation();
        copySelection();
      } else if (key === 'v' && host.contains(document.activeElement)) {
        // Ctrl+V (and Ctrl+Shift+V) paste, as everywhere else on the computer: the key is kept from the terminal, which
        // would send it to the program as a control character, and the browser's own paste — which needs no permission —
        // puts the text in. What is pasted goes the way of everything typed: only from whoever holds the keyboard.
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const onMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (term.hasSelection()) copySelection();
      else pasteClipboard();
    };
    host.addEventListener('contextmenu', onMenu);

    const dataSub = term.onData((data) => {
      // Observers never send input. (The server would drop it anyway.)
      if (interactive && controllingRef.current) connection.send({ t: 'term.input', sessionId, data });
    });

    const ro = new ResizeObserver(() => fitPaneToPanel());
    ro.observe(host);
    connection.send({ t: 'term.open', sessionId });

    return () => {
      ro.disconnect();
      window.removeEventListener('keydown', onKey, true);
      host.removeEventListener('contextmenu', onMenu);
      selectionSub.dispose();
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
      {selected && !closed && (
        // The mouse button must not take the selection (or the keyboard) away before the click arrives.
        <button type="button" className="term-copy" title="Copy what is selected (Ctrl+C, or the right mouse button)" onMouseDown={(e) => e.preventDefault()} onClick={() => copyRef.current()}>
          Copy
        </button>
      )}
      {loading && !closed && <div className="term-overlay">Connecting to the real terminal…</div>}
      {closed && <div className="term-overlay term-overlay-closed">Terminal unavailable: {closed}</div>}
    </div>
  );
}
