import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { connection } from '../lib/api.ts';
import { onTerminal, useOffice } from '../lib/store.ts';
import { copyText, selectionText } from './clipboard.ts';
import { FIRST_GUESS, MIN_FONT, cellRatios, fontToFit, type CellRatios } from './scale.ts';

interface Props {
  sessionId: string;
  /** Read-only tiles (terminal wall) never take keyboard focus. */
  interactive?: boolean;
  /** While controlling, resize the real pane to fit this panel. */
  fitPane?: boolean;
  /** Watching in a window wider than the pane: ask the office to make the pane as wide (the workstation view; not the small tiles of the wall). */
  widen?: boolean;
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
/** The size of letter a watched terminal is widened for: what one reads comfortably for hours. */
const WATCH_FONT = 15;

export function TerminalView({ sessionId, interactive = true, fitPane = false, widen = false, className, onClosed }: Props) {
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
  const widenRef = useRef(widen);
  widenRef.current = widen;
  /** `widenToPanel` of the terminal that is mounted (it is defined after what calls it). */
  const widenRef2 = useRef<() => void>(() => undefined);

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

    /** What a character cell really takes in this window, per pixel of font size: measured once the terminal has drawn. */
    let ratios: CellRatios = FIRST_GUESS;
    let settling = 0;
    /** The terminal's drawing as it is on screen right now. */
    const drawn = (): { width: number; height: number } | null => {
      const screen = host.querySelector<HTMLElement>('.xterm-screen');
      return screen && screen.clientWidth > 0 ? { width: screen.clientWidth, height: screen.clientHeight } : null;
    };

    /**
     * Scale the font so the pane's exact cols×rows fill the panel (no reflow: tmux owns the size, and someone who only
     * watches never changes it). As large as fits: in a big window a 120-column pane is drawn with big letters rather
     * than left in a corner with half the window empty (`scale.ts`).
     */
    const scaleToPane = () => {
      const { cols, rows } = paneSize.current;
      const panel = { width: host.clientWidth - 8, height: host.clientHeight - 4 };
      if (panel.width <= 0 || panel.height <= 0) return;
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      const size = fontToFit(panel, cols, rows, ratios);
      if (term.options.fontSize !== size) term.options.fontSize = size;
      // Cells are whole pixels and differ from font to font, so what was worked out is checked against what was drawn:
      // the real ratios are kept for the next time, and a drawing that came out larger than the panel is stepped down.
      const round = ++settling;
      let changes = 0;
      let frames = 0;
      // The terminal redraws a frame or two after its font changes: nothing is measured until two frames in a row
      // show the same drawing, and not before two frames have passed since the last change.
      let wait = 2;
      let last: { width: number; height: number } | null = null;
      const check = () => {
        if (round !== settling || termRef.current !== term || frames++ > 90) return;
        const now = drawn();
        if (!now || term.cols !== cols || term.rows !== rows) return void requestAnimationFrame(check);
        const steady = wait-- <= 0 && !!last && last.width === now.width && last.height === now.height;
        last = now;
        if (!steady) return void requestAnimationFrame(check);
        const font = term.options.fontSize ?? size;
        ratios = cellRatios(now, cols, rows, font) ?? ratios;
        const over = now.width > panel.width + 1 || now.height > panel.height + 1;
        const better = fontToFit(panel, cols, rows, ratios);
        // Too large: down to what the measured cells say (or a step, if that says the same). Clearly too small: up.
        const next = Math.max(MIN_FONT, over ? Math.min(better, font - 0.5) : better - font > 0.5 ? better : font);
        // Settled, and the cell's real size is known: now it can be said whether the pane fills the window.
        if (next === font || changes++ >= 8) return void widenRef2.current();
        term.options.fontSize = next;
        wait = 2;
        last = null;
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    };

    /**
     * Watching, with a window the pane does not fill at a size one reads comfortably: ask for a wider (and taller)
     * pane. The office only ever grows it, so this is asked once per size and settles.
     */
    let asked = '';
    const widenToPanel = () => {
      if (!widenRef.current || controllingRef.current) return;
      const panel = { width: host.clientWidth - 8, height: host.clientHeight - 4 };
      if (panel.width <= 0 || panel.height <= 0) return;
      const cols = Math.floor(panel.width / (WATCH_FONT * ratios.w));
      const rows = Math.floor(panel.height / (WATCH_FONT * ratios.h));
      const now = paneSize.current;
      // (A few columns either way are not worth a redraw of somebody's terminal.)
      if (cols < now.cols + 8 && rows < now.rows + 4) return;
      const want = `${Math.max(cols, now.cols)}x${Math.max(rows, now.rows)}`;
      if (want === asked) return;
      asked = want;
      connection.send({ t: 'term.widen', sessionId, cols: Math.max(cols, now.cols), rows: Math.max(rows, now.rows) });
    };

    widenRef2.current = widenToPanel;

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
        // (Asked again here in case nothing gets measured — a window that is not being drawn settles nothing.)
        window.setTimeout(() => widenRef2.current(), 1500);
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

    const ro = new ResizeObserver(() => {
      fitPaneToPanel();
      widenToPanel();
    });
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
