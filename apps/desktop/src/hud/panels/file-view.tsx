/**
 * (Also `VideoViewer`, below: a video or a sound an employee left, played over the conversation or the ticket.)
 *
 * A file read in the window: what an employee left as text (a check's output, notes, a patch, JSON) opens over the
 * conversation or the ticket it is on, instead of being downloaded to be looked at. Which files: `lib/readable.ts`.
 */
import { useEffect, useState } from 'react';
import { Button, Markdown } from '@orchestrator/ui';
import { shownOf, type Reading } from '../../lib/readable.ts';

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
