import { createElement, useEffect, useRef, useState } from 'react';
import type { TvSettings } from '@orchestrator/contracts';
import { Button } from '@orchestrator/ui';
import { api } from '../lib/api.ts';
import { useOffice } from '../lib/store.ts';
import { clearTvFrame, toAddress, tvBridge, youtubeEmbed, type TvPage } from '../lib/tv.ts';
import { act, ask } from './core.tsx';
import { registerPanel } from './panels/index.tsx';

const FALLBACK: TvSettings = { home: 'https://www.youtube.com/', bookmarks: [] };

/** The methods of Electron's <webview> element that the TV uses. */
interface WebviewEl extends HTMLElement {
  loadURL: (url: string) => Promise<void>;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  setAudioMuted: (muted: boolean) => void;
  getURL: () => string;
}

/**
 * The office TV. Once switched on it stays alive behind the scenes: closing its window only hides
 * it, so music keeps playing while you walk around; "Turn off" really stops it.
 * In the desktop app this is a real browser (an embedded, sandboxed <webview> with its own
 * storage). In a plain browser tab only YouTube video can be shown, embedded.
 */
export function TvLayer() {
  const on = useOffice((s) => s.tv.on);
  const visible = useOffice((s) => s.panel === 'tv');
  // Opening the TV "panel" from anywhere switches it on.
  useEffect(() => {
    if (visible && !on) useOffice.setState((s) => ({ tv: { ...s.tv, on: true } }));
  }, [visible, on]);
  useEffect(() => {
    if (!on) clearTvFrame();
  }, [on]);
  // One set per switch-on: its browser starts where it was asked to go, and is gone when switched off.
  return on ? <TvSet visible={visible} /> : null;
}

function TvSet({ visible }: { visible: boolean }) {
  const goto = useOffice((s) => s.tv.goto);
  const page = useOffice((s) => s.tv.page);
  const settings = useOffice((s) => s.settings?.tv ?? FALLBACK);
  const bridge = tvBridge();
  const view = useRef<WebviewEl | null>(null);
  const ready = useRef(false);
  const [address, setAddress] = useState('');
  const [typing, setTyping] = useState(false);
  const [muted, setMuted] = useState(false);
  const [editing, setEditing] = useState(false);
  // Where the browser starts: what was asked for when the TV was switched on, or home.
  const [start] = useState(() => useOffice.getState().tv.goto?.url ?? settings.home);
  // The last request that was acted on. Each one is followed once; after that the page goes where its own links lead.
  const handled = useRef(useOffice.getState().tv.goto?.n ?? 0);
  // In a browser tab: what is embedded now.
  const [embed, setEmbed] = useState<string | null>(() => youtubeEmbed(start));

  // What the page reports (desktop app).
  useEffect(() => {
    if (!bridge) return;
    return bridge.onState((state: TvPage | null) => useOffice.setState((s) => (s.tv.on ? { tv: { ...s.tv, page: state } } : s)));
  }, [!!bridge]);

  // Asked to go somewhere after it was switched on (a bookmark, the address bar).
  useEffect(() => {
    if (!goto || goto.n === handled.current) return;
    if (!bridge) {
      handled.current = goto.n;
      return setEmbed(youtubeEmbed(goto.url));
    }
    if (!ready.current || !view.current) return; // picked up when the browser is ready
    handled.current = goto.n;
    void view.current.loadURL(goto.url).catch(() => undefined);
  }, [goto?.n]);

  useEffect(() => {
    if (!typing) setAddress(page?.url ?? goto?.url ?? start);
  }, [page?.url, goto?.n, typing]);

  // Keys belong to the office again once the TV is put away.
  useEffect(() => {
    if (!visible) (document.activeElement as HTMLElement | null)?.blur?.();
  }, [visible]);

  const go = (url: string) => useOffice.getState().tvOpen(url);
  const close = () => useOffice.getState().openPanel(null);
  const off = () => useOffice.getState().tvOff();
  const saveBookmarks = (bookmarks: TvSettings['bookmarks'], ok: string) => act(() => api('PATCH', '/settings', { tv: { ...settings, bookmarks } }), ok);
  const here = page?.url ?? '';
  const bookmarked = settings.bookmarks.some((b) => b.url === here);

  return (
    <div className={`tv-layer ${visible ? 'tv-visible' : ''}`} aria-hidden={!visible}>
      <div className="tv-backdrop" onClick={close} />
      <div className="tv-set glass" role="dialog" aria-label="TV">
        <div className="tv-bar">
          {bridge && (
            <>
              <Button small disabled={!page?.canGoBack} onClick={() => view.current?.goBack()} aria-label="Back" title="Back">
                ◀
              </Button>
              <Button small disabled={!page?.canGoForward} onClick={() => view.current?.goForward()} aria-label="Forward" title="Forward">
                ▶
              </Button>
              <Button small onClick={() => (page?.loading ? view.current?.stop() : view.current?.reload())} aria-label={page?.loading ? 'Stop loading' : 'Reload'} title={page?.loading ? 'Stop loading' : 'Reload'}>
                {page?.loading ? '✕' : '⟳'}
              </Button>
            </>
          )}
          <Button small onClick={() => go(settings.home)} title={`Home: ${settings.home}`}>
            Home
          </Button>
          <form
            className="tv-address"
            onSubmit={(ev) => {
              ev.preventDefault();
              const url = toAddress(address);
              setTyping(false);
              if (url) go(url);
              (ev.currentTarget.querySelector('input') as HTMLInputElement | null)?.blur();
            }}
          >
            <input
              className="mono"
              value={address}
              aria-label="Address or search"
              placeholder={bridge ? 'Type an address, or anything to search' : 'Paste a YouTube link'}
              spellCheck={false}
              onFocus={(ev) => {
                setTyping(true);
                ev.currentTarget.select();
              }}
              onBlur={() => setTyping(false)}
              onChange={(ev) => setAddress(ev.target.value)}
            />
          </form>
          {bridge && (
            <>
              <Button
                small
                onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  view.current?.setAudioMuted(next);
                }}
                title={muted ? 'Sound is off' : 'Sound is on'}
                aria-pressed={muted}
              >
                {muted ? 'Unmute' : 'Mute'}
              </Button>
              <Button
                small
                disabled={!here || bookmarked}
                title={bookmarked ? 'Already in your bookmarks' : 'Add this page to the bookmarks below'}
                onClick={() => void saveBookmarks([...settings.bookmarks, { name: (page?.title || here).slice(0, 40), url: here }], 'Bookmarked')}
              >
                ★
              </Button>
            </>
          )}
          <Button small variant="danger" onClick={off} title="Switch the TV off: the page is closed and the sound stops">
            Turn off
          </Button>
          <Button small variant="ghost" onClick={close} title="Put the TV away. It keeps playing; come back to it at the TV or from the top bar." aria-label="Close and keep playing">
            ✕
          </Button>
        </div>
        <div className="tv-marks">
          {settings.bookmarks.map((b) => (
            <span key={b.url} className="tv-mark">
              <button type="button" onClick={() => go(b.url)} title={b.url}>
                {b.name}
              </button>
              {editing && (
                <button type="button" className="tv-mark-x" aria-label={`Remove ${b.name}`} onClick={() => void saveBookmarks(settings.bookmarks.filter((x) => x.url !== b.url), 'Removed')}>
                  ✕
                </button>
              )}
            </span>
          ))}
          <span className="grow" />
          {here && here !== settings.home && bridge && (
            <button type="button" className="fp-link" onClick={() => void act(() => api('PATCH', '/settings', { tv: { ...settings, home: here } }), 'This page is now where the TV starts')}>
              start here next time
            </button>
          )}
          {settings.bookmarks.length > 0 && (
            <button type="button" className="fp-link" onClick={() => setEditing((e) => !e)}>
              {editing ? 'done' : 'edit bookmarks'}
            </button>
          )}
          {bridge && (
            <button
              type="button"
              className="fp-link"
              title="Forget the cookies, logins and cache of the TV's browser"
              onClick={() => void ask({ title: 'Forget what the TV has stored?', body: 'Cookies, logins and the cache are deleted. You will have to sign in to sites again.', ok: 'Forget', danger: true }).then((yes) => { if (yes) void bridge.forget().then(() => useOffice.getState().toast('The TV forgot what it had stored', 'success')); })}
            >
              forget browsing data
            </button>
          )}
        </div>
        <div className="tv-screen">
          {bridge ? (
            // Electron's embedded browser. `partition` and an http(s) `src` are enforced again in the main process.
            createElement('webview', {
              ref: (el: WebviewEl | null) => {
                if (!el || view.current === el) return;
                view.current = el;
                el.addEventListener('dom-ready', () => {
                  if (ready.current) return;
                  ready.current = true;
                  // Something else was asked for while the browser was starting: go there now, once.
                  const wanted = useOffice.getState().tv.goto;
                  if (wanted && wanted.n !== handled.current) {
                    handled.current = wanted.n;
                    void el.loadURL(wanted.url).catch(() => undefined);
                  }
                });
              },
              src: start,
              partition: bridge.partition,
              allowpopups: 'true',
              className: 'tv-web',
            })
          ) : embed ? (
            <iframe className="tv-web" src={embed} title="TV" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin" />
          ) : (
            <div className="tv-note">
              <div className="strong">In a browser tab the TV can only show YouTube videos.</div>
              <div className="muted">Paste a YouTube link above. The desktop app has a full browser here (any site, music, search).</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// The TV is not an ordinary panel window: it lives in `TvLayer` so it can keep playing while hidden.
// Registering an empty panel makes "open the tv panel" valid everywhere panels are opened.
registerPanel('tv', () => null);
