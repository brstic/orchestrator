/**
 * Finding words in what was said (the Rent portal's search, `docs/RENT.md`). One rule on both sides — the server that
 * finds the lines and the page that marks the words in them: every word of the query must be in the text, in any
 * order, ignoring case and accents ("cao" finds "Ćao", "resume" finds "résumé").
 */

const FOLD: Record<string, string> = { đ: 'd', Đ: 'd', ß: 'ss', ł: 'l', Ł: 'l', ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe' };

function foldChar(c: string): string {
  return FOLD[c] ?? c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** A text as it is compared: lower case, without accents. */
export function foldText(s: string): string {
  let out = '';
  for (const c of s) out += foldChar(c);
  return out;
}

/** The words of a query (folded, each once, at most 8; a query longer than 200 characters is cut). */
export function searchWords(q: unknown): string[] {
  const words = foldText(String(q ?? '').slice(0, 200))
    .split(/\s+/)
    .filter(Boolean);
  return [...new Set(words)].slice(0, 8);
}

/** Whether every word is in the text. No words: nothing matches. */
export function matchesWords(text: string, words: string[]): boolean {
  if (!words.length) return false;
  const t = foldText(text);
  return words.every((w) => t.includes(w));
}

/** Where the words are in the text, as [start, end) of the text itself (not of its folded form), in order, merged. */
export function matchRanges(text: string, words: string[]): Array<[number, number]> {
  if (!words.length || !text) return [];
  // The folded text, and for each of its characters the place in the text it came from.
  let folded = '';
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const c of text) {
    const f = foldChar(c);
    for (let k = 0; k < f.length; k++) {
      folded += f[k];
      from.push(i);
      to.push(i + c.length);
    }
    i += c.length;
  }
  const found: Array<[number, number]> = [];
  for (const w of words) {
    for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + w.length)) found.push([from[at]!, to[at + w.length - 1]!]);
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** A piece of a long text around its first match, to show under a search hit (with … where it was cut). */
export function snippetOf(text: string, words: string[], room = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= room) return flat;
  const first = matchRanges(flat, words)[0];
  const start = first ? Math.max(0, Math.min(first[0] - Math.floor(room / 3), flat.length - room)) : 0;
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + room).trim()}${start + room < flat.length ? '…' : ''}`;
}
