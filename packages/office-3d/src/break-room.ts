/**
 * What people do in the break room (the owner, 2026-11-20: "when the agents are in the break room, let something
 * actually happen, not only standing still — let them make coffee, look in the fridge, watch TV, talk among
 * themselves"). Every place to be in it is for something (`BreakAct`); somebody on a break goes from one to another
 * every half a minute or so (`breakPlan`), and two who are there at once can stand and talk.
 *
 * Who is at what right now is told to the things they use (`markInUse` / `inUse`): the coffee machine pours and
 * steams, the tap runs, the fridge door opens and its light comes on — only while somebody is there.
 */
export type BreakAct = 'tv' | 'coffee' | 'sink' | 'fridge' | 'chat';

/** How long one activity lasts before they go to another (ms), and how much that differs between people. */
export const BREAK_TURN_MS = 32_000;

const lastUse: Record<BreakAct, number> = { tv: 0, coffee: 0, sink: 0, fridge: 0, chat: 0 };
/** Somebody is at this, this frame (called from their frame loop while they are there). */
export function markInUse(act: BreakAct): void {
  lastUse[act] = performance.now();
}
/** Whether somebody is at this now (marked within the last moment). */
export function inUse(act: BreakAct): boolean {
  return performance.now() - lastUse[act] < 400;
}

export interface BreakPlace {
  x: number;
  z: number;
  rot: number;
  sit: boolean;
  act: BreakAct;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Who is at which place of the break room now. `who`: the people on a break (in a stable order); `places`: the room's
 * places. Each person's turn changes every `BREAK_TURN_MS` (offset per person, so they do not all move at once); in
 * each turn they want the places in an order of their own, and take the first free one. The two places to talk are
 * taken together by two people or not at all — nobody talks to the air. Returns place index per person (or -1).
 */
export function breakPlan(who: string[], places: BreakPlace[], now: number): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  const chat = places.map((p, i) => (p.act === 'chat' ? i : -1)).filter((i) => i >= 0);
  // Two of them talk when at least two are there and it is their turn to, by the clock: a talk lasts a turn too.
  const turn = Math.floor(now / BREAK_TURN_MS);
  if (who.length >= 2 && chat.length === 2) {
    const ranked = [...who].sort((a, b) => ((hash(a) + turn * 977) % 1009) - ((hash(b) + turn * 977) % 1009));
    // (Not in every turn: about two turns of three.)
    if ((hash(ranked[0]!) + turn) % 3 !== 0) {
      out.set(ranked[0]!, chat[0]!);
      out.set(ranked[1]!, chat[1]!);
      taken.add(chat[0]!);
      taken.add(chat[1]!);
    }
  }
  for (const id of who) {
    if (out.has(id)) continue;
    const h = hash(id);
    const mine = Math.floor((now + (h % BREAK_TURN_MS)) / BREAK_TURN_MS);
    const order = places
      .map((p, i) => ({ i, k: (hash(`${id}:${mine}:${i}`) % 1000) + (p.act === 'chat' ? 5000 : 0) }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.i);
    const pick = order.find((i) => !taken.has(i) && places[i]!.act !== 'chat');
    if (pick === undefined) {
      out.set(id, -1);
      continue;
    }
    taken.add(pick);
    out.set(id, pick);
  }
  return out;
}

/** A few words people say over a cup — drawn over the head of whoever is talking. */
export const CHAT_WORDS = ['…', '😄', '☕', '👍', 'haha', '🤔', '🙂', 'nice!', '😂', 'right?', '🍕', '💡'];
