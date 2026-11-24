/**
 * (Also `VideoViewer`, below: a video or a sound an employee left, played over the conversation or the ticket.)
 *
 * A file read in the window: what an employee left as text (a check's output, notes, a patch, JSON) opens over the
 * conversation or the ticket it is on, instead of being downloaded to be looked at. Which files: `lib/readable.ts`.
 */
import { useEffect, useState } from 'react';
import { Button, Markdown } from '@orchestrator/ui';
import { shownOf, type Reading } from '../../lib/readable.ts';
import { serverBase } from '../../lib/api.ts';

export function TextViewer({ name, note, as, load, onDownload, onClose }: { name: string; note?: string | null; as: Reading; load: () => Promise<Blob>; onDownload: () => void; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    load()
      .then((b) => b.text())
      .then(
        (t) => live && setText(t),
        (e) => live && setFailed((e as Error).message || 'It could not be loaded.'),
      );
    return () => {
      live = false;
    };
    // (Loaded once, for the file this was opened on.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      // (Only this closes: the window underneath listens for Escape too — see the picture viewer.)
      ev.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  const shown = text === null ? null : shownOf(text);
  const lines = shown ? shown.text.split('\n').length : 0;
  return (
    <div className="tf-lightbox tf-reader-box" role="dialog" aria-label={name} onClick={onClose} data-reader={name} data-esc-first>
      <div className="tf-reader" onClick={(ev) => ev.stopPropagation()}>
        {failed ? (
          <div className="muted">{failed}</div>
        ) : shown === null ? (
          <div className="muted">loading…</div>
        ) : !shown.text.trim() ? (
          <div className="muted">The file is empty.</div>
        ) : as === 'markdown' ? (
          <Markdown text={shown.text} />
        ) : (
          <pre className="tf-reader-text">{shown.text}</pre>
        )}
        {shown?.cut && <div className="tf-reader-cut small">This is the beginning of a long file. Download it to read the rest.</div>}
      </div>
      <div className="tf-lightbox-bar tf-reader-bar" onClick={(ev) => ev.stopPropagation()}>
        <span className="strong truncate">{name}</span>
        <span className="muted truncate">
          {note ? `${note} · ` : ''}
          {shown ? `${lines} ${lines === 1 ? 'line' : 'lines'}` : ''}
        </span>
        <span className="grow" />
        <Button
          small
          disabled={!shown}
          onClick={() =>
            void navigator.clipboard?.writeText(text ?? '').then(
              () => (setCopied(true), window.setTimeout(() => setCopied(false), 1500)),
              () => undefined,
            )
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button small onClick={onDownload}>
          Download
        </Button>
        <Button small variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

/**
 * A video an employee left (a screen recording, a demo of what they built), played over the conversation or the
 * ticket it is on. It is fetched whole when it is opened (a file given through the office is at most 100 MB), and
 * played with the player's own controls; Escape or a click beside it closes it.
 */
export function VideoViewer({ name, note, size, audio = false, load, onDownload, onClose }: { name: string; note?: string | null; size?: string | null; /** A sound: a player without a picture. */ audio?: boolean; load: () => Promise<Blob>; onDownload: () => void; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    load().then(
      (b) => {
        if (!live) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      },
      (e) => live && setFailed((e as Error).message || 'It could not be loaded.'),
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
    // (Loaded once, for the file this was opened on.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      // (Only this closes: the window underneath listens for Escape too — see the picture viewer.)
      ev.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  return (
    <div className="tf-lightbox" role="dialog" aria-label={name} onClick={onClose} {...(audio ? { 'data-sound': name } : { 'data-video': name })} data-esc-first>
      {failed ? (
        <div className="muted">{failed}</div>
      ) : url && audio ? (
        <div className="tf-sound" onClick={(ev) => ev.stopPropagation()}>
          <div className="tf-sound-name truncate">♪ {name}</div>
          <audio src={url} controls autoPlay onError={() => setFailed('This sound cannot be played here (its format is not one the player knows). Download it to listen.')} />
        </div>
      ) : url ? (
        <video className="tf-video" src={url} controls autoPlay playsInline onClick={(ev) => ev.stopPropagation()} onError={() => setFailed('This video cannot be played here (its format is not one the player knows). Download it to watch it.')} />
      ) : (
        <span className="muted">loading{size ? ` ${size}` : ''}…</span>
      )}
      <div className="tf-lightbox-bar" onClick={(ev) => ev.stopPropagation()}>
        <span className="strong truncate">{name}</span>
        <span className="muted truncate">
          {note ?? ''}
          {note && size ? ' · ' : ''}
          {size ?? ''}
        </span>
        <span className="grow" />
        <Button small onClick={onDownload}>
          Download
        </Button>
        <Button small variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

/**
 * A page an employee made (HTML, an SVG) shown as the page it is: in a frame of its own, sandboxed — it runs as itself
 * but reaches nothing of the office — loaded from a ticket the office gives for that one file (`page-view.ts`). Its
 * source on a click; in the computer's browser on another (the ticket works there for a few minutes, without signing in).
 */
export function PageViewer({ name, note, ticket, load, onDownload, onClose }: { name: string; note?: string | null; ticket: () => Promise<{ url: string }>; load: () => Promise<Blob>; onDownload: () => void; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  useEffect(() => {
    let live = true;
    ticket().then(
      (t) => live && setUrl(`${serverBase}${t.url}`),
      (e) => live && setFailed((e as Error).message || 'It could not be opened.'),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (source) return;
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose, source]);
  if (source) return <TextViewer name={name} note={note ? `${note} · source` : 'source'} as="text" load={load} onDownload={onDownload} onClose={() => setSource(false)} />;
  return (
    <div className="tf-lightbox tf-reader-box" role="dialog" aria-label={name} onClick={onClose} data-page-view={name} data-esc-first>
      <div className="tf-page" onClick={(ev) => ev.stopPropagation()}>
        {failed ? (
          <div className="muted" style={{ padding: 16 }}>{failed}</div>
        ) : !url ? (
          <div className="muted" style={{ padding: 16 }}>loading…</div>
        ) : (
          <iframe className="tf-page-frame" title={name} src={url} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-forms" referrerPolicy="no-referrer" />
        )}
      </div>
      <div className="tf-lightbox-bar tf-reader-bar" onClick={(ev) => ev.stopPropagation()}>
        <span className="strong truncate">{name}</span>
        {note && <span className="muted truncate">{note}</span>}
        <span className="grow" />
        <Button small onClick={() => setSource(true)} title="The page's HTML">
          Source
        </Button>
        {url && (
          <a className="btn btn-default btn-sm" href={url} target="_blank" rel="noopener noreferrer" title="Open the page in this computer's browser (for a few minutes)">
            Open in browser
          </a>
        )}
        <Button small onClick={onDownload}>
          Download
        </Button>
        <Button small variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

/**
 * A page shown in the conversation itself — the owner, 2026-11-24, of an HTML an employee gave: "I don't see it in
 * Talk" (it was a name to click). A small live view of the page (the same sandbox and ticket as `PageViewer`); a click
 * on it opens it over the window.
 */
export function PagePreview({ name, ticket, onOpen }: { name: string; ticket: () => Promise<{ url: string }>; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    ticket().then(
      (t) => live && setUrl(`${serverBase}${t.url}`),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (failed) return null;
  return (
    <div className="tf-page-preview" data-page-preview={name}>
      {url ? <iframe title={name} src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" tabIndex={-1} /> : <div className="small muted" style={{ padding: 12 }}>loading the page…</div>}
      <button type="button" className="tf-page-preview-open" onClick={onOpen} aria-label={`Open ${name}`} title="Open the page" />
    </div>
  );
}
