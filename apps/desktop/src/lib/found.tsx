import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { matchRanges } from '@orchestrator/contracts';

/**
 * Showing what a search found (the Rent portal and the office's Rent tab, `docs/RENT.md`, "Search"): the words marked
 * where they are, by the rule of `@orchestrator/contracts` `search.ts` (any case, any accent).
 */

/** A short text with the words marked (`<mark>`): a hit under a search box. */
export function Marked({ text, words, className }: { text: string; words: string[]; className?: string }) {
  const ranges = matchRanges(text, words);
  if (!ranges.length) return <span className={className}>{text}</span>;
  const parts: Array<string | { m: string }> = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) parts.push(text.slice(at, a));
    parts.push({ m: text.slice(a, b) });
    at = b;
  }
  if (at < text.length) parts.push(text.slice(at));
  return (
    <span className={className}>
      {parts.map((p, i) => (typeof p === 'string' ? p : <mark key={i}>{p.m}</mark>))}
    </span>
  );
}

interface HighlightRegistry {
  set(name: string, h: unknown): void;
  delete(name: string): void;
}
const registry = (): { reg: HighlightRegistry; make: (ranges: Range[]) => unknown } | null => {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  return css?.highlights && H ? { reg: css.highlights, make: (r) => new H(...r) } : null;
};

/**
 * The words marked in everything shown under `root` (whole conversations, Markdown and all), without changing what
 * is drawn: the CSS Custom Highlight API, styled by `::highlight(<name>)`. A browser without it marks nothing here
 * (the line found is still shown and outlined). Run again whenever `deps` change (new lines, other words).
 */
export function useFoundMarks(root: RefObject<HTMLElement | null>, words: string[], name: string, deps: unknown[]): void {
  useLayoutEffect(() => {
    const r = registry();
    if (!r) return;
    const el = root.current;
    if (!el || !words.length) {
      r.reg.delete(name);
      return;
    }
    const ranges: Range[] = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n && ranges.length < 2000; n = walk.nextNode()) {
      const t = n.nodeValue ?? '';
      if (!t.trim() || (n.parentElement && n.parentElement.closest('[data-found-skip]'))) continue;
      for (const [a, b] of matchRanges(t, words)) {
        const range = document.createRange();
        range.setStart(n, a);
        range.setEnd(n, b);
        ranges.push(range);
      }
    }
    r.reg.set(name, r.make(ranges));
    return () => r.reg.delete(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, name, words.join(' '), ...deps]);
}

/** A value that follows another after it has been still for `ms` (what is typed, before it is searched). */
export function useSettled<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}
