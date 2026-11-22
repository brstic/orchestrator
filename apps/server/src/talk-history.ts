import { TALK_EVENT_TYPES, isTalkEvent, isTalkMessage, matchesWords, searchWords, talkTextOfEvent, talkTextOfMessage, type Message, type OrchestratorEvent } from '@orchestrator/contracts';
import type { Storage } from '@orchestrator/database';

/**
 * The whole of the boss's conversation with an employee, for Talk (the owner, 2026-11-22: "in Talk I must see the
 * whole history of the conversation, and search through it — now it shows only as much as the current session").
 * The office's state carries only the newest 300 messages of the whole office and the window asked for the newest 400
 * events of the employee, so an older conversation fell off. Here it is read from where it is kept — every message in
 * the store, every event in the record — a page at a time going back, or from a moment on, and searched as a whole.
 *
 * `canMessage` / `canEvent`: what the person asking may read (`access.ts`), applied to every line.
 */
export interface TalkDeps {
  store: Pick<Storage, 'queryEvents'>;
  messages: () => Message[];
  canMessage: (m: Message) => boolean;
  canEvent: (e: OrchestratorEvent) => OrchestratorEvent | null;
}

export interface TalkPage {
  messages: Message[];
  events: OrchestratorEvent[];
  /** The moment the page begins at: the next page back is asked for `before` it. */
  from: string | null;
  /** Whether there is anything older than this page. */
  more: boolean;
}

const TYPES = [...TALK_EVENT_TYPES];
const PAGE = 2000;

/** Every event of the conversation, newest first, going back (from `before`, down to `since`), at most `cap`. */
function* eventsBack(d: TalkDeps, employeeId: string, opts: { before?: string; since?: string; cap: number }): Generator<OrchestratorEvent> {
  let beforeSeq: number | undefined;
  let given = 0;
  for (;;) {
    const got = d.store.queryEvents({ employeeId, types: TYPES, before: opts.before, since: opts.since, beforeSeq, limit: PAGE });
    for (let i = got.length - 1; i >= 0; i--) {
      const e = got[i]!;
      if (!isTalkEvent(e)) continue;
      const shown = d.canEvent(e);
      if (!shown) continue;
      yield shown;
      if (++given >= opts.cap) return;
    }
    if (got.length < PAGE) return;
    beforeSeq = got[0]!.seq;
  }
}

const messagesOf = (d: TalkDeps, employeeId: string) =>
  d
    .messages()
    .filter((m) => isTalkMessage(m, employeeId) && d.canMessage(m))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

/**
 * A page of the conversation: the newest `limit` lines before `before` (or the newest of all) — or, with `since`,
 * every line from that moment on (to show an old line a search found, and all that came after it), at most 5000.
 */
export function talkPage(d: TalkDeps, employeeId: string, opts: { before?: string; since?: string; limit?: number }): TalkPage {
  const all = messagesOf(d, employeeId);
  if (opts.since) {
    const since = opts.since;
    const events = [...eventsBack(d, employeeId, { since, cap: 5000 })].reverse();
    const messages = all.filter((m) => m.createdAt >= since);
    const older = all.some((m) => m.createdAt < since) || d.store.queryEvents({ employeeId, types: TYPES, before: since, limit: 1 }).length > 0;
    return { messages, events, from: since, more: older };
  }
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
  const before = opts.before;
  const msgs = (before ? all.filter((m) => m.createdAt < before) : all).slice(-(limit + 1));
  const evs = [...eventsBack(d, employeeId, { before, cap: limit + 1 })].reverse();
  const merged = [...msgs.map((m) => m.createdAt), ...evs.map((e) => e.ts)].sort();
  if (merged.length <= limit) return { messages: msgs, events: evs, from: merged[0] ?? null, more: false };
  // The page begins at the moment of its oldest line; whatever else falls at that same moment comes with it.
  const from = merged[merged.length - limit]!;
  return { messages: msgs.filter((m) => m.createdAt >= from), events: evs.filter((e) => e.ts >= from), from, more: true };
}

export interface TalkHit {
  id: string;
  ts: string;
  kind: 'boss' | 'group' | 'reply' | 'file' | 'note';
  text: string;
}

/** Every line of the whole conversation that has all the words (`search.ts`), newest first, at most `limit`. */
export function talkSearch(d: TalkDeps, employeeId: string, q: unknown, limit = 300): { hits: TalkHit[]; more: boolean; words: string[] } {
  const words = searchWords(q);
  if (!words.length) return { hits: [], more: false, words };
  const hits: TalkHit[] = [];
  for (const m of messagesOf(d, employeeId)) {
    const text = talkTextOfMessage(m);
    if (matchesWords(text, words)) hits.push({ id: m.id, ts: m.createdAt, kind: m.channel === 'telegram' && m.chat ? 'group' : 'boss', text });
  }
  for (const e of eventsBack(d, employeeId, { cap: 200_000 })) {
    const text = talkTextOfEvent(e);
    if (matchesWords(text, words)) hits.push({ id: e.id, ts: e.ts, kind: e.type === 'agent.turn_finished' ? 'reply' : e.type === 'agent.file_given' ? 'file' : 'note', text });
  }
  hits.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const n = Math.max(1, Math.min(1000, limit));
  return { hits: hits.slice(0, n), more: hits.length > n, words };
}
