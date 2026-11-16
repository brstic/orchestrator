/**
 * Files that go with what is said to an employee: a screenshot pasted into the conversation (Ctrl+V), a file dropped
 * on it or chosen with the button. Each is sent to the office the moment it is added, so that sending the message
 * does not wait; the office puts them on the employee's machine with the message (`said-files.ts` there).
 */
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { SaidFile } from '@orchestrator/contracts';
import { api, apiBlob } from '../../lib/api.ts';
import { familyOf, playableAs, readableAs } from '../../lib/readable.ts';
import { TextViewer, VideoViewer } from './file-view.tsx';

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_SAID_FILES = 10;
const CHUNK = 384 * 1024; // as base64 it stays under half a megabyte: through any proxy in front of the office
const SHOWN = /^image\/(png|jpeg|gif|webp)$/;

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A screenshot from the clipboard has no name of its own ("image.png" every time): give it one that says when. */
export function named(f: File, now = new Date()): File {
  if (f.name && f.name !== 'image.png') return f;
  const p = (n: number) => String(n).padStart(2, '0');
  const ext = (f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
  return new File([f], `screenshot-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`, { type: f.type });
}

/** Why a file cannot go along, or null. */
export function refusal(f: Pick<File, 'name' | 'size'>, already: number): string | null {
  if (already >= MAX_SAID_FILES) return `At most ${MAX_SAID_FILES} files go with one message.`;
  if (f.size === 0) return `${f.name} is empty.`;
  if (f.size > MAX_FILE_BYTES) return `${f.name} is larger than 100 MB. Put it on their machine and name its path instead.`;
  return null;
}

export interface Pending {
  key: string;
  file: File;
  /** A picture, to show before it is sent. */
  preview: string | null;
  /** 0…1 while it is on its way; 1 when the office has it. */
  progress: number;
  /** What the office calls it, once it has it. */
  said: SaidFile | null;
  error: string | null;
}

async function upload(employeeId: string, file: File, onProgress: (done: number) => void): Promise<SaidFile> {
  const begun = await api<SaidFile>('POST', `/employees/${employeeId}/files`, { name: file.name, size: file.size });
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const piece = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
    const res = await api<{ received: number }>('POST', `/employees/${employeeId}/files/${begun.id}/data`, { offset, dataBase64: base64(piece) });
    onProgress(res.received / file.size);
  }
  return begun;
}

/**
 * The files waiting to go with the next message to one employee. `add` takes them from a paste, a drop or the file
 * dialog and starts sending each at once; `ready()` waits until the office has them all and gives their ids.
 */
export function usePendingFiles(employeeId: string | null, onRefused: (why: string) => void) {
  const [files, setFiles] = useState<Pending[]>([]);
  const live = useRef(files);
  live.current = files;
  const patch = (key: string, p: Partial<Pending>) => setFiles((all) => all.map((f) => (f.key === key ? { ...f, ...p } : f)));
  const waiting = useRef(new Map<string, Promise<void>>());

  // Another employee, or the window closed: what was waiting is not carried along.
  useEffect(
    () => () => {
      for (const f of live.current) if (f.preview) URL.revokeObjectURL(f.preview);
      setFiles([]);
      waiting.current.clear();
    },
    [employeeId],
  );

  const add = (more: File[]) => {
    if (!employeeId) return;
    let count = live.current.length;
    const fresh: Pending[] = [];
    for (const raw of more) {
      const file = named(raw);
      const why = refusal(file, count);
      if (why) {
        onRefused(why);
        continue;
      }
      count++;
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fresh.push({ key, file, preview: SHOWN.test(file.type) ? URL.createObjectURL(file) : null, progress: 0, said: null, error: null });
    }
    if (!fresh.length) return;
    setFiles((all) => [...all, ...fresh]);
    for (const f of fresh) {
      waiting.current.set(
        f.key,
        upload(employeeId, f.file, (progress) => patch(f.key, { progress })).then(
          (said) => patch(f.key, { said, progress: 1 }),
          (e) => patch(f.key, { error: (e as Error).message }),
        ),
      );
    }
  };

  const remove = (key: string) => {
    const f = live.current.find((x) => x.key === key);
    if (f?.preview) URL.revokeObjectURL(f.preview);
    waiting.current.delete(key);
    setFiles((all) => all.filter((x) => x.key !== key));
  };

  /** Wait for what is still on its way; the ids the office gave, or an error naming the file that did not arrive. */
  const ready = async (): Promise<string[]> => {
    await Promise.all([...waiting.current.values()]);
    // (State set by the uploads above is read on the next tick.)
    await new Promise((r) => setTimeout(r, 0));
    const failed = live.current.find((f) => f.error || !f.said);
    if (failed) throw new Error(failed.error ? `${failed.file.name}: ${failed.error}` : `${failed.file.name} has not reached the office. Remove it and attach it again.`);
    return live.current.map((f) => f.said!.id);
  };

  const clear = () => {
    for (const f of live.current) if (f.preview) URL.revokeObjectURL(f.preview);
    waiting.current.clear();
    setFiles([]);
  };

  return {
    files,
    add,
    remove,
    ready,
    clear,
    /** For the text box and the area around it. */
    onPaste: (ev: ClipboardEvent) => {
      const pasted = [...ev.clipboardData.files];
      if (!pasted.length) return; // plain text: left to the text box
      ev.preventDefault();
      add(pasted);
    },
    onDrop: (ev: DragEvent) => {
      if (!ev.dataTransfer.files.length) return;
      ev.preventDefault();
      add([...ev.dataTransfer.files]);
    },
  };
}

/** What waits to go with the message: a small picture or the file's name, how far it is, and a way to take it out. */
export function PendingStrip({ files, onRemove }: { files: Pending[]; onRemove: (key: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="said-strip" aria-label="Files that go with this message">
      {files.map((f) => (
        <div key={f.key} className={`said-chip ${f.error ? 'said-chip-bad' : ''}`} title={f.error ?? `${f.file.name} · ${fileSize(f.file.size)}`} data-said-pending={f.said ? 'ready' : f.error ? 'failed' : 'sending'}>
          {f.preview ? <img src={f.preview} alt="" /> : <span className="said-ext">{f.file.name.split('.').pop()?.slice(0, 4) ?? 'file'}</span>}
          <span className="said-name truncate">{f.error ? 'not sent' : f.progress < 1 && !f.said ? `${Math.round(f.progress * 100)}%` : f.file.name}</span>
          <button type="button" className="said-x" onClick={() => onRemove(f.key)} aria-label={`Remove ${f.file.name}`}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// A picture that was said is fetched once per window; the office keeps it for a few days only.
const urls = new Map<string, Promise<string>>();
const urlOf = (employeeId: string, id: string): Promise<string> => {
  let u = urls.get(id);
  if (!u) {
    u = apiBlob(`/employees/${employeeId}/files/${id}`).then((b) => URL.createObjectURL(b));
    u.catch(() => urls.delete(id));
    urls.set(id, u);
  }
  return u;
};

function SaidPicture({ employeeId, file }: { employeeId: string; file: SaidFile }) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let live = true;
    urlOf(employeeId, file.id).then(
      (u) => live && setUrl(u),
      () => live && setGone(true),
    );
    return () => {
      live = false;
    };
  }, [employeeId, file.id]);
  if (gone) return <span className="said-sent-doc" title="The office keeps a file that was said for a few days; the employee's machine still has it.">{file.name} · no longer kept here</span>;
  if (!url) return <span className="said-sent-doc">{file.name}…</span>;
  return (
    <>
      <button type="button" className="said-sent-pic" onClick={() => setBig(true)} title={`${file.name} · ${fileSize(file.size)} — click to look closer`}>
        <img src={url} alt={file.name} />
      </button>
      {big && (
        <div className="said-big" onClick={() => setBig(false)} role="dialog" aria-label={file.name}>
          <img src={url} alt={file.name} />
        </div>
      )}
    </>
  );
}

/** The files of a message, as the conversation shows them: pictures to look at, other files by name. */
export function SaidFilesOf({ employeeId, files }: { employeeId: string; files: SaidFile[] }) {
  if (!files.length) return null;
  return (
    <div className="said-sent" data-said-files={files.length}>
      {files.map((f) =>
        SHOWN.test(f.mime) ? (
          <SaidPicture key={f.id} employeeId={employeeId} file={f} />
        ) : (
          <span key={f.id} className="said-sent-doc" title={fileSize(f.size)}>
            {f.name}
          </span>
        ),
      )}
    </div>
  );
}

// ───────────── the other way: what an employee gave ─────────────

async function saveSaid(employeeId: string, file: SaidFile): Promise<void> {
  const href = await urlOf(employeeId, file.id);
  const link = document.createElement('a');
  link.href = href;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** A file an employee gave in the conversation: a picture is shown (a click looks closer), a video plays, text is read, anything can be downloaded. */
export function GivenFile({ employeeId, file, caption, onError }: { employeeId: string; file: SaidFile; caption: string | null; onError: (why: string) => void }) {
  const [open, setOpen] = useState(false);
  const reading = readableAs(file.name, file.mime, file.size);
  const media = playableAs(file.name, file.mime);
  const video = !!media;
  const save = () => void saveSaid(employeeId, file).catch(() => onError('The office no longer keeps this file (a file given in a conversation is kept for a few days).'));
  return (
    <div className="said-given" data-given-file={file.name}>
      {SHOWN.test(file.mime) && (
        <div className="said-sent">
          <SaidPicture employeeId={employeeId} file={file} />
        </div>
      )}
      <div className="said-given-row">
        <button type="button" className={`tp-doc tp-doc-${familyOf(file.name, file.mime)}`} title={`${file.name} · ${fileSize(file.size)} — ${video ? 'play it here' : reading ? 'open it here' : 'download'}`} onClick={() => (reading || video ? setOpen(true) : save())} data-file={file.name} data-file-reads={reading ? 'yes' : media ?? 'no'}>
          <span className="tf-ext">{(file.name.split('.').pop() ?? 'file').slice(0, 5)}</span>
          <span className="truncate">{file.name}</span>
          <span className="faint">{fileSize(file.size)}</span>
          <span className="tp-doc-does">{video ? '▶ Play' : reading ? 'Open' : 'Download'}</span>
        </button>
        {(reading || video) && (
          <button type="button" className="tf-link" onClick={save}>
            Download
          </button>
        )}
      </div>
      {open && reading && <TextViewer name={file.name} note={caption} as={reading} load={() => apiBlob(`/employees/${employeeId}/files/${file.id}`)} onDownload={save} onClose={() => setOpen(false)} />}
      {open && video && <VideoViewer name={file.name} note={caption} size={fileSize(file.size)} audio={media === 'audio'} load={() => apiBlob(`/employees/${employeeId}/files/${file.id}`)} onDownload={save} onClose={() => setOpen(false)} />}
      {caption && <div className="small">{caption}</div>}
    </div>
  );
}
