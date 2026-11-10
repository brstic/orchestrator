import { Fragment, type ReactNode } from 'react';

/**
 * A small Markdown renderer for what agents write: headings, emphasis, inline
 * code, fenced code, lists (nested, ordered, task lists), block quotes, tables,
 * rules and links. It builds React elements directly — no HTML is ever parsed
 * or injected, so agent output cannot smuggle markup or scripts into the UI.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={`md ${className ?? ''}`}>{blocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'))}</div>;
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function inline(src: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  // Order matters: code first (its contents are literal), then links, then emphasis.
  const re = /(`+)([\s\S]+?)\1|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\n]+?)\*|(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  let n = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const key = `${keyBase}-${n++}`;
    if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (m[3] !== undefined) {
      const href = m[4]!;
      out.push(
        SAFE_URL.test(href) ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {inline(m[3], key)}
          </a>
        ) : (
          // Relative paths and anything that is not a web link stay text: they point into the agent's folder, not the app.
          <span key={key} className="md-ref" title={href}>
            {inline(m[3], key)}
          </span>
        ),
      );
    } else if (m[5] !== undefined)
      out.push(
        <a key={key} href={m[5]} target="_blank" rel="noopener noreferrer">
          {m[5]}
        </a>,
      );
    else if (m[6] !== undefined || m[7] !== undefined) out.push(<strong key={key}>{inline((m[6] ?? m[7])!, key)}</strong>);
    else if (m[8] !== undefined) out.push(<del key={key}>{inline(m[8], key)}</del>);
    else if (m[9] !== undefined || m[10] !== undefined) out.push(<em key={key}>{inline((m[9] ?? m[10])!, key)}</em>);
    else if (m[11] !== undefined)
      out.push(
        <a key={key} href={m[11]} target="_blank" rel="noopener noreferrer">
          {m[11]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

function list(lines: string[], start: number, indent: number): { node: ReactNode; next: number } {
  const first = LIST.exec(lines[start]!)!;
  const ordered = /\d/.test(first[2]!);
  const items: ReactNode[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]!);
    if (!m || m[1]!.length < indent || (m[1]!.length === indent && /\d/.test(m[2]!) !== ordered)) break;
    if (m[1]!.length > indent) break;
    const body: string[] = [m[3]!];
    i++;
    const children: ReactNode[] = [];
    while (i < lines.length) {
      const line = lines[i]!;
      const sub = LIST.exec(line);
      if (sub && sub[1]!.length > indent) {
        const nested = list(lines, i, sub[1]!.length);
        children.push(<Fragment key={`n${i}`}>{nested.node}</Fragment>);
        i = nested.next;
      } else if (sub) break;
      else if (!line.trim()) {
        // A blank line ends the item unless more of the list follows.
        const after = lines[i + 1];
        if (after !== undefined && (LIST.test(after) || /^\s{2,}\S/.test(after))) i++;
        else break;
      } else if (/^\s{2,}\S/.test(line) || !/^(#{1,6}\s|```|>|\|)/.test(line.trim())) {
        body.push(line.trim());
        i++;
      } else break;
    }
    const text = body.join(' ');
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
    items.push(
      <li key={`li${i}`} className={task ? 'md-task' : undefined}>
        {task ? <input type="checkbox" checked={task[1] !== ' '} readOnly disabled /> : null}
        {inline(task ? task[2]! : text, `li${i}`)}
        {children}
      </li>,
    );
  }
  const Tag = ordered ? 'ol' : 'ul';
  const from = ordered ? Number(/\d+/.exec(first[2]!)![0]) : undefined;
  return { node: <Tag start={from && from !== 1 ? from : undefined}>{items}</Tag>, next: i };
}

function blocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `b${k++}`;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]![0] === '`' ? '`' : '~'}{${fence[1]!.length},}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push(
        <pre key={key()} className="md-code" data-lang={fence[2] || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1]!.length);
      const Tag = `h${level}` as 'h1';
      out.push(<Tag key={key()}>{inline(heading[2]!, `h${k}`)}</Tag>);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''));
      out.push(<blockquote key={key()}>{blocks(body)}</blockquote>);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!)) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : undefined));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(
        <div key={key()} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={{ textAlign: align[j] }}>
                    {inline(c, `th${k}-${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: align[j] }}>
                      {inline(r[j] ?? '', `td${k}-${ri}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const res = list(lines, i, li[1]!.length);
      out.push(<Fragment key={key()}>{res.node}</Fragment>);
      i = res.next;
      continue;
    }
    // A paragraph runs until a blank line or the start of another block. Single newlines are kept as line breaks.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]!) && !LIST.test(lines[i]!) && !(lines[i]!.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!))) para.push(lines[i++]!);
    const pk = key();
    out.push(
      <p key={pk}>
        {para.map((l, j) => (
          <Fragment key={j}>
            {j > 0 ? <br /> : null}
            {inline(l.trim(), `${pk}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}
