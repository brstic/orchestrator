/**
 * Keys that something on the page holds for itself for now — a game on the arcade holds its players' buttons. The
 * office's own shortcuts that listen before anything else (push-to-talk) ask here first and leave such a key alone;
 * the ones that listen later never hear it at all.
 */
let taker: ((code: string) => boolean) | null = null;

/** Take keys for as long as needed: `holds(code)` says whether a key is taken right now. Returns how to give them back. */
export function takeKeys(holds: (code: string) => boolean): () => void {
  taker = holds;
  return () => {
    if (taker === holds) taker = null;
  };
}

export const keyTaken = (code: string): boolean => !!taker?.(code);
