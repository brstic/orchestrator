import type { RadioNow, RadioStation } from '@orchestrator/contracts';

/**
 * The office's hi-fi: which station is on, since when and who switched it. It is the office's, not a window's —
 * everyone in the office is told and plays the stream themselves (the server relays no audio). Kept in memory
 * only: after a restart the hi-fi is off.
 *
 * A station is named by its id and comes from the office's saved list, so nobody can make every other window
 * load an address of their choosing: adding to that list is an owner's act (the settings).
 */
export class HiFi {
  private now: RadioNow | null = null;
  private stations: () => RadioStation[];
  private onChange: (now: RadioNow | null) => void;

  constructor(stations: () => RadioStation[], onChange: (now: RadioNow | null) => void) {
    this.stations = stations;
    this.onChange = onChange;
  }

  get current(): RadioNow | null {
    return this.now;
  }

  /**
   * Switch a saved station on. `url`, when the caller says which address they mean, has to be that station's:
   * a window with an older list does not start something else than it shows. Null: no such station.
   */
  play(want: { stationId?: unknown; url?: unknown }, by: RadioNow['by']): RadioNow | null {
    const list = this.stations();
    const id = typeof want.stationId === 'string' ? want.stationId : null;
    const url = typeof want.url === 'string' ? want.url : null;
    const station = id ? list.find((s) => s.id === id) : url ? list.find((s) => s.url === url) : undefined;
    if (!station || (url !== null && station.url !== url)) return null;
    this.set({ station: { ...station }, since: new Date().toISOString(), by });
    return this.now;
  }

  stop(): void {
    if (this.now) this.set(null);
  }

  /** The list of stations changed: a station that was removed stops playing, one whose address was changed plays from the new one. */
  stationsChanged(): void {
    if (!this.now) return;
    const station = this.stations().find((s) => s.id === this.now!.station.id);
    if (!station) this.set(null);
    else if (JSON.stringify(station) !== JSON.stringify(this.now.station)) this.set({ ...this.now, station: { ...station } });
  }

  private set(now: RadioNow | null): void {
    this.now = now;
    this.onChange(now);
  }
}

/**
 * What a radio station says is on air. The server asks, so the office page itself never needs
 * permission to call outside addresses; only a short title comes back, never the reply itself.
 */
const cache = new Map<string, { at: number; text: string | null }>();
const MAX_BYTES = 512 * 1024;

export async function nowPlaying(url: string): Promise<string | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 10_000) return hit.text;
  let text: string | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (res.ok && res.body) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('too large');
        chunks.push(chunk);
      }
      const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // AzuraCast ({now_playing:{song:{text}}}), Icecast-style ({icestats:{source:{title}}}), or a plain {artist, title}.
      const source = Array.isArray(j?.icestats?.source) ? j.icestats.source[0] : j?.icestats?.source;
      const found = j?.now_playing?.song?.text ?? source?.title ?? ([j?.artist, j?.title].filter((x) => typeof x === 'string' && x).join(' - ') || null);
      if (typeof found === 'string' && found.trim()) text = found.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 200);
    }
  } catch {
    text = null; // the station does not say, or cannot be reached
  }
  if (cache.size > 200) cache.clear();
  cache.set(url, { at: Date.now(), text });
  return text;
}
