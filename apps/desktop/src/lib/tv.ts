/**
 * The office TV: a web browser in the owner's own window. In the desktop app it is a real
 * embedded browser (an Electron <webview> in its own storage partition); in a plain browser tab
 * only embeddable video (YouTube) is possible. Nothing here touches the employees or the server,
 * except the home page and bookmarks, which are saved in the settings.
 */
export interface TvPage {
  url: string;
  title: string;
  audible: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface Bridge {
  partition: string;
  onState: (cb: (state: TvPage | null) => void) => () => void;
  onFrame: (cb: (jpegBase64: string) => void) => () => void;
  forget: () => Promise<boolean>;
}

/** Present only in the desktop app. */
export const tvBridge = (): Bridge | null => (window as unknown as { orchestrator?: { tv?: Bridge } }).orchestrator?.tv ?? null;

// The picture of the TV (about one frame a second) goes straight to whoever draws it — the screen
// in the 3D office — and never through the store, so nothing else re-renders for it.
let latest: string | null = null;
const listeners = new Set<(jpegBase64: string | null) => void>();
let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  tvBridge()?.onFrame((frame) => {
    latest = frame;
    for (const l of listeners) l(frame);
  });
}

/** Subscribe to the TV's picture; called at once with the latest frame, if there is one. */
export function onTvFrame(cb: (jpegBase64: string | null) => void): () => void {
  wire();
  listeners.add(cb);
  if (latest) cb(latest);
  return () => listeners.delete(cb);
}

export function clearTvFrame(): void {
  latest = null;
  for (const l of listeners) l(null);
}

/** What was typed in the address bar: an address as it is, anything else as a search. */
export function toAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null; // file:, javascript:, … are not for the TV
  if (!/\s/.test(text) && /^[^\s/]+\.[a-z]{2,}(\/.*)?$/i.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

/** A YouTube address as something a plain browser tab is allowed to embed, or null. */
export function youtubeEmbed(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = u.pathname.slice(1);
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') id = u.pathname.startsWith('/embed/') ? u.pathname.slice(7) : u.pathname.startsWith('/shorts/') ? u.pathname.slice(8) : u.searchParams.get('v');
    const list = u.searchParams.get('list');
    if (id && /^[A-Za-z0-9_-]{6,20}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1${list && /^[A-Za-z0-9_-]+$/.test(list) ? `&list=${list}` : ''}`;
    if (list && /^[A-Za-z0-9_-]+$/.test(list)) return `https://www.youtube-nocookie.com/embed/videoseries?list=${list}&autoplay=1`;
  } catch {
    /* not an address */
  }
  return null;
}
