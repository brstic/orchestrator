import type { TerminalScreen } from '@orchestrator/contracts';

/**
 * Draws a real terminal frame (tmux capture with SGR colours) onto a canvas,
 * for the monitors in the 3D office. This is a renderer for genuine terminal
 * content — it never invents text.
 */

const BASE16 = ['#1b2230', '#ff6b7d', '#6fd08c', '#f0c36a', '#6ea8ff', '#c792ea', '#5fd3d0', '#d7dde8', '#5b6677', '#ff8a98', '#8ee6a6', '#ffd98a', '#8fbcff', '#dab0ff', '#86e6e3', '#ffffff'];
const FG = '#cfd6e2';
const BG = '#0b0f17';

function color256(n: number): string {
  if (n < 16) return BASE16[n]!;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}

interface Run {
  text: string;
  fg: string;
  bg: string | null;
  bold: boolean;
  dim: boolean;
}

/** Split one captured line into styled runs. Unknown escapes are skipped. */
export function parseSgrLine(line: string, state: { fg: string; bg: string | null; bold: boolean; dim: boolean; inverse: boolean }): Run[] {
  const runs: Run[] = [];
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const fg = state.inverse ? (state.bg ?? BG) : state.fg;
    const bg = state.inverse ? state.fg : state.bg;
    runs.push({ text, fg, bg, bold: state.bold, dim: state.dim });
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    push(line.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] === undefined) continue;
    const codes = m[1] === '' ? [0] : m[1].split(';').map((x) => Number(x) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) Object.assign(state, { fg: FG, bg: null, bold: false, dim: false, inverse: false });
      else if (c === 1) state.bold = true;
      else if (c === 2) state.dim = true;
      else if (c === 22) (state.bold = false), (state.dim = false);
      else if (c === 7) state.inverse = true;
      else if (c === 27) state.inverse = false;
      else if (c >= 30 && c <= 37) state.fg = BASE16[c - 30]!;
      else if (c === 39) state.fg = FG;
      else if (c >= 40 && c <= 47) state.bg = BASE16[c - 40]!;
      else if (c === 49) state.bg = null;
      else if (c >= 90 && c <= 97) state.fg = BASE16[c - 90 + 8]!;
      else if (c >= 100 && c <= 107) state.bg = BASE16[c - 100 + 8]!;
      else if (c === 38 || c === 48) {
        let col: string | null = null;
        if (codes[i + 1] === 5) {
          col = color256(codes[i + 2] ?? 7);
          i += 2;
        } else if (codes[i + 1] === 2) {
          col = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
          i += 4;
        }
        if (col) {
          if (c === 38) state.fg = col;
          else state.bg = col;
        }
      }
    }
  }
  push(line.slice(last));
  return runs;
}

export interface DrawOptions {
  /** Draw fewer rows with larger text for monitors seen from far away. */
  lod?: 'near' | 'far';
  dimmed?: boolean;
}

export function drawScreen(ctx: CanvasRenderingContext2D, w: number, h: number, screen: TerminalScreen | null | undefined, opts: DrawOptions = {}): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  if (!screen || !screen.lines.length) return;
  const cols = Math.max(20, screen.cols);
  const rows = Math.max(5, screen.rows);
  const pad = 6;
  const cw = (w - pad * 2) / cols;
  const chH = (h - pad * 2) / rows;
  const fontSize = Math.max(4, Math.min(chH * 0.86, cw * 1.62));
  ctx.textBaseline = 'top';
  const state = { fg: FG, bg: null as string | null, bold: false, dim: false, inverse: false };
  const far = opts.lod === 'far';
  for (let r = 0; r < Math.min(rows, screen.lines.length); r++) {
    const runs = parseSgrLine(screen.lines[r]!, state);
    let col = 0;
    const y = pad + r * chH;
    for (const run of runs) {
      const width = [...run.text].length;
      if (col >= cols) break;
      if (run.bg) {
        ctx.fillStyle = run.bg;
        ctx.fillRect(pad + col * cw, y, Math.min(width, cols - col) * cw, chH);
      }
      if (run.text.trim()) {
        ctx.fillStyle = run.fg;
        ctx.globalAlpha = (run.dim ? 0.55 : 1) * (opts.dimmed ? 0.5 : 1);
        if (far) {
          // From a distance text is unreadable anyway: draw each word as a bar of its real colour and length.
          let i = 0;
          for (const part of run.text.split(/(\s+)/)) {
            const len = [...part].length;
            if (part.trim()) ctx.fillRect(pad + (col + i) * cw, y + chH * 0.28, len * cw - cw * 0.3, chH * 0.42);
            i += len;
          }
        } else {
          ctx.font = `${run.bold ? '600 ' : ''}${fontSize}px "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace`;
          // Fixed cell advance keeps box-drawing and columns aligned regardless of the font's own metrics.
          let i = 0;
          for (const ch of run.text) {
            if (ch !== ' ') ctx.fillText(ch, pad + (col + i) * cw, y + (chH - fontSize) / 2);
            i++;
            if (col + i >= cols) break;
          }
        }
        ctx.globalAlpha = 1;
      }
      col += width;
    }
  }
  if (screen.cursor.visible && !far) {
    ctx.fillStyle = '#7fb0ff';
    ctx.globalAlpha = 0.85;
    ctx.fillRect(pad + screen.cursor.x * cw, pad + screen.cursor.y * chH, cw, chH);
    ctx.globalAlpha = 1;
  }
}
