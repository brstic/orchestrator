import { useEffect, useRef, useState } from 'react';
import { EMOTE_SECONDS, isEmotePose, type PoseName } from './motion.ts';

/**
 * What a person's character is doing on top of standing or walking, each for a moment: cracking the whip, flinching
 * from someone else's, or a gesture from the wheel. Each is announced by a time that changes (`whipAt`, `ouchAt`) or
 * a new object (`emote`); the latest one wins, and when its time is up the character is back to how it stood.
 */
export interface Acts {
  /** When they last cracked the whip (ms). */
  whipAt?: number;
  /** When someone's whip lands on them (ms; a moment after that person's swing began). */
  ouchAt?: number;
  /** The gesture they last asked for, and when. */
  emote?: { name: string; at: number } | null;
}

/** How long the swing and the flinch are held, in milliseconds. */
export const WHIP_MS = 700;
const OUCH_MS = 950;

/**
 * The pose to give `Character` and its `cue` (which restarts a one-shot pose when the same one is asked for again);
 * `null` pose: nothing special, stand or walk. `whipping`: the whip is in the hand.
 */
export function useActs(acts: Acts): { pose: PoseName | null; cue: number | undefined; whipping: boolean } {
  const [now, setNow] = useState<{ pose: PoseName; cue: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const play = (pose: PoseName, cue: number, ms: number, delay = 0) => {
    if (timer.current) clearTimeout(timer.current);
    const start = () => {
      setNow({ pose, cue });
      timer.current = setTimeout(() => setNow(null), ms);
    };
    if (delay > 0) timer.current = setTimeout(start, delay);
    else start();
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const seenWhip = useRef(acts.whipAt ?? 0);
  useEffect(() => {
    if (!acts.whipAt || acts.whipAt === seenWhip.current) return;
    seenWhip.current = acts.whipAt;
    play('whip', acts.whipAt, WHIP_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acts.whipAt]);

  const seenOuch = useRef(acts.ouchAt ?? 0);
  useEffect(() => {
    if (!acts.ouchAt || acts.ouchAt === seenOuch.current) return;
    seenOuch.current = acts.ouchAt;
    // Nothing for a blow that landed long ago (a window that has just come in is told about old ones).
    if (Date.now() - acts.ouchAt > 1500) return;
    play('ouch', acts.ouchAt, OUCH_MS, Math.max(0, acts.ouchAt - Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acts.ouchAt]);

  const seenEmote = useRef(acts.emote?.at ?? 0);
  useEffect(() => {
    const e = acts.emote;
    if (!e || e.at === seenEmote.current) return;
    seenEmote.current = e.at;
    if (!isEmotePose(e.name) || Date.now() - e.at > 1500) return;
    play(e.name, e.at, EMOTE_SECONDS[e.name] * 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acts.emote?.at, acts.emote?.name]);

  return { pose: now?.pose ?? null, cue: now?.cue, whipping: now?.pose === 'whip' };
}
