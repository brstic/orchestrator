import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
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

/**
 * Addresses that are this machine or its own network. An office that people reach from outside does not ask them
 * for anybody: a saved "now playing" address would otherwise be a way to make the server read from services that
 * only it can reach (its own ports, the router, a cloud provider's metadata address).
 */
const INSIDE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) INSIDE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) INSIDE.addSubnet(net, bits, 'ipv6');

export function isInside(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const a = mapped ? mapped[1]! : address;
  const kind = isIP(a);
  if (!kind) return true; // not an address at all: nothing to ask
  return INSIDE.check(a, kind === 6 ? 'ipv6' : 'ipv4');
}

/** May the server ask this address? Every address its name resolves to has to be outside. */
export async function outsideAddress(url: string, resolve: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true })).map((a) => a.address)): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return !isInside(host);
  try {
    const all = await resolve(host);
    return all.length > 0 && all.every((a) => !isInside(a));
  } catch {
    return false;
  }
}

const REDIRECTS = 3;

/**
 * `insideToo`: the office is not reachable from outside (no door), so whoever saved the station sits at this
 * machine and may well mean a stream on it or beside it. Otherwise the address — and every address it sends us on
 * to — has to be outside. The name is resolved here and again by the request itself; a name that changes its
 * answer between the two is not caught (only a short title of a JSON reply in one of three shapes ever comes back).
 */
export async function nowPlaying(url: string, opts: { insideToo?: boolean } = {}): Promise<string | null> {
  if (!opts.insideToo && !(await outsideAddress(url))) return null;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 10_000) return hit.text;
  let text: string | null = null;
  try {
    let at = url;
    let res = await fetch(at, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' }, redirect: 'manual' });
    for (let hop = 0; res.status >= 300 && res.status < 400; hop++) {
      const to = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!to || hop >= REDIRECTS) throw new Error('sent on too often');
      at = new URL(to, at).toString();
      if (!/^https?:/.test(at) || (!opts.insideToo && !(await outsideAddress(at)))) throw new Error('sent on to an address the office does not ask');
      res = await fetch(at, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' }, redirect: 'manual' });
    }
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
