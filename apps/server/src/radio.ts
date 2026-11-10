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
