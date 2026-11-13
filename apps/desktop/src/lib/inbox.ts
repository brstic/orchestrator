/**
 * The words and the order of the Inbox (docs/UI.md): one line for what somebody asks, the day a piece of news
 * belongs to, and how an answer fared. Nothing here touches the page.
 */

/** A long text as one line: its first line that says something, without Markdown's marks, cut at a word. */
export function oneLine(text: string | null | undefined, most = 140): string {
  const first = (text ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[#>*-]+|\d+\.)\s+/, '').replace(/[*_`]{1,3}/g, '').trim())
    .find((l) => l.length > 0);
  if (!first) return '';
  if (first.length <= most) return first;
  const cut = first.slice(0, most);
  const at = cut.lastIndexOf(' ');
  return `${(at > most * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/** What an approval is asked for, as far as one line can say it: the command, the file, or the tool's name. */
export function approvalLine(tool: { name?: string | null; input?: unknown } | null | undefined, text: string): string {
  const input = (tool?.input ?? null) as { command?: unknown; file_path?: unknown; path?: unknown; url?: unknown } | null;
  const what = [input?.command, input?.file_path, input?.path, input?.url].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (what) return `${tool?.name ? `${tool.name}: ` : ''}${oneLine(what, 110)}`;
  return oneLine(text);
}

export type Day = 'Today' | 'Yesterday' | 'Earlier';

/** Which day something belongs to, as people say it, by this computer's calendar. */
export function dayOf(iso: string, now: number = Date.now()): Day {
  const start = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((start(now) - start(Date.parse(iso))) / 86_400_000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : 'Earlier';
}

/** A list in the order it came, cut into days: only the days that have something. */
export function byDay<T extends { createdAt: string }>(rows: readonly T[], now: number = Date.now()): Array<{ day: Day; rows: T[] }> {
  const out: Array<{ day: Day; rows: T[] }> = [];
  for (const r of rows) {
    const day = dayOf(r.createdAt, now);
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else out.push({ day, rows: [r] });
  }
  return out;
}

/** How an answer fared on its way to the employee: a word, and whether it is one to look at. */
export function deliveryWord(status: string): { word: string; tone: 'calm' | 'warn' | 'bad' } {
  switch (status) {
    case 'confirmed':
      return { word: 'arrived', tone: 'calm' };
    case 'answered':
    case 'delivered':
      return { word: 'on its way', tone: 'calm' };
    case 'failed':
      return { word: 'did not arrive', tone: 'bad' };
    case 'superseded':
      return { word: 'settled elsewhere', tone: 'calm' };
    default:
      return { word: status, tone: 'calm' };
  }
}

/** "3 need you", "1 needs you", "Nothing needs you". */
export function needLine(n: number): string {
  return n === 0 ? 'Nothing needs you' : `${n} need${n === 1 ? 's' : ''} you`;
}
