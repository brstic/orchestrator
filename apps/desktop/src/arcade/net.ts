import type { ServerToClient } from '@orchestrator/contracts';

/**
 * What the office passes on about a table (docs/ARCADE.md, "Playing with somebody in the office"): the host's
 * picture and sound for those who sat down, the second pad's buttons for the host. It comes in with everything else
 * the office says (`lib/store.ts`) and is handed on here to whoever is playing right now.
 */
export type TableNews = Extract<ServerToClient, { t: 'arcade.media' | 'arcade.pad' | 'arcade.key' | 'arcade.closed' }>;

const listeners = new Set<(m: TableNews) => void>();

export function onTableNews(fn: (m: TableNews) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function hearTableNews(m: TableNews): void {
  for (const fn of listeners) fn(m);
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
