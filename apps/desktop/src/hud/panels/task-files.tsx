import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { Task, TaskAttachment } from '@orchestrator/contracts';
import { Button } from '@orchestrator/ui';
import { api, apiBlob } from '../../lib/api.ts';
import { useAccess } from '../../lib/access.ts';
import { useOffice } from '../../lib/store.ts';
import { familyOf, isPageFile, playableAs, readableAs } from '../../lib/readable.ts';
import { act, ask } from '../core.tsx';
import { PageViewer, TextViewer, VideoViewer } from './file-view.tsx';

/**
 * Files on a task: what people attach for the employee (a picture of the bug, a mock-up, a document), and what the
 * employee leaves as evidence (a screenshot of the result). Pictures are shown; everything else is a download.
 */

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
const CHUNK = 384 * 1024; // as base64 it stays under half a megabyte: through any proxy in front of the office
const SHOWN = /^image\/(png|jpeg|gif|webp)$/;

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Send one file to a task, in pieces. `onProgress` gets 0…1. */
export async function uploadFile(taskId: string, file: File, onProgress?: (done: number) => void): Promise<TaskAttachment> {
  if (file.size === 0) throw new Error(`${file.name} is empty`);
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 100 MB. Put it on the machine and name its path in the task instead.`);
  const begun = await api<TaskAttachment>('POST', `/tasks/${taskId}/attachments`, { name: file.name || 'pasted.png', size: file.size });
  let last = begun;
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const piece = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
    const res = await api<{ received: number; done: boolean; attachment: TaskAttachment }>('POST', `/tasks/${taskId}/attachments/${begun.id}/data`, { offset, dataBase64: base64(piece) });
    last = res.attachment;
    onProgress?.(res.received / file.size);
  }
  return last;
}

// A picture is fetched once per window and kept while the window lives.
const urls = new Map<string, Promise<string>>();
const urlOf = (taskId: string, a: TaskAttachment): Promise<string> => {
  let u = urls.get(a.id);
  if (!u) {
    u = apiBlob(`/tasks/${taskId}/attachments/${a.id}`).then((b) => URL.createObjectURL(b));
    u.catch(() => urls.delete(a.id));
    urls.set(a.id, u);
  }
  return u;
};

async function download(taskId: string, a: TaskAttachment): Promise<void> {
  const blob = await apiBlob(`/tasks/${taskId}/attachments/${a.id}`);
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = a.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

function Thumb({ taskId, a, onOpen }: { taskId: string; a: TaskAttachment; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    urlOf(taskId, a).then(
      (u) => live && setUrl(u),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [taskId, a]);
  if (failed) return <div className="tf-thumb tf-thumb-none small muted">could not be loaded</div>;
  return (
    <button type="button" className="tf-thumb" title={`${a.name} — open`} onClick={() => url && onOpen(url)} aria-label={`Open ${a.name}`}>
      {url ? <img src={url} alt={a.caption ?? a.name} /> : <span className="small faint">loading…</span>}
    </button>
  );
}

function FileCard({ task, a, mayChange, onOpen }: { task: Task; a: TaskAttachment; mayChange: boolean; onOpen: (a: TaskAttachment, url: string) => void }) {
  const remove = async () => {
    if (!(await ask({ title: `Remove ${a.name}?`, body: `It is taken off ${task.key} and deleted from the office.${a.kind === 'input' ? ' A copy already sent to an employee\'s machine stays there.' : ''}`, ok: 'Remove' }))) return;
    void act(() => api('DELETE', `/tasks/${task.id}/attachments/${a.id}`), `${a.name} removed`);
  };
  const [playing, setPlaying] = useState(false);
  const [viewing, setViewing] = useState(false);
  return (
    <div className="tf-file" data-attachment={a.name} data-kind={a.kind}>
      {SHOWN.test(a.mime) ? (
        <Thumb taskId={task.id} a={a} onOpen={(url) => onOpen(a, url)} />
      ) : playableAs(a.name, a.mime) ? (
        <button type="button" className="tf-thumb tf-thumb-doc tf-thumb-video" title={`${a.name} — play`} onClick={() => setPlaying(true)} aria-label={`Play ${a.name}`}>
          <span className="tf-play">▶</span>
        </button>
      ) : isPageFile(a.name) ? (
        <button type="button" className="tf-thumb tf-thumb-doc" title={`${a.name} — open the page`} onClick={() => setViewing(true)} aria-label={`Open ${a.name}`}>
          <span className="tf-ext">{(a.name.split('.').pop() ?? 'file').slice(0, 5)}</span>
        </button>
      ) : (
        <button type="button" className="tf-thumb tf-thumb-doc" title={`${a.name} — download`} onClick={() => void act(() => download(task.id, a))}>
          <span className="tf-ext">{(a.name.split('.').pop() ?? 'file').slice(0, 5)}</span>
        </button>
      )}
      <div className="tf-meta">
        <div className="small strong truncate" title={a.name}>
          {a.name}
        </div>
        {a.caption && (
          <div className="small truncate" title={a.caption}>
            {a.caption}
          </div>
        )}
        <div className="small faint truncate">
          {size(a.size)} · {a.addedBy.name}
        </div>
        <div className="row" style={{ gap: 4 }}>
          {isPageFile(a.name) && (
            <button type="button" className="tf-link" onClick={() => setViewing(true)} data-open-page={a.name}>
              Open
            </button>
          )}
          <button type="button" className="tf-link" onClick={() => void act(() => download(task.id, a))}>
            Download
          </button>
          {mayChange && (
            <button type="button" className="tf-link tf-link-danger" onClick={() => void remove()}>
              Remove
            </button>
          )}
        </div>
      </div>
      {viewing && <PageViewer name={a.name} note={a.caption ? `${a.caption} · ${a.addedBy.name}` : a.addedBy.name} ticket={() => api<{ url: string }>('POST', `/tasks/${task.id}/attachments/${a.id}/page`, {})} load={() => apiBlob(`/tasks/${task.id}/attachments/${a.id}`)} onDownload={() => void act(() => download(task.id, a))} onClose={() => setViewing(false)} />}
      {playing && <VideoViewer audio={playableAs(a.name, a.mime) === 'audio'} name={a.name} note={a.caption ? `${a.caption} · ${a.addedBy.name}` : a.addedBy.name} size={size(a.size)} load={() => apiBlob(`/tasks/${task.id}/attachments/${a.id}`)} onDownload={() => void act(() => download(task.id, a))} onClose={() => setPlaying(false)} />}
    </div>
  );
}

/** The files of one task, with a way to add more (a button, a drop, a paste). `only`: one of the two groups, without the adding. */
export function TaskFiles({ task, only }: { task: Task; only?: 'evidence' }) {
  const projects = useOffice((s) => s.projects);
  const can = useAccess();
  const mayChange = can.work(projects[task.projectId]?.hostId);
  const [sending, setSending] = useState<{ name: string; done: number } | null>(null);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<{ a: TaskAttachment; url: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const all = task.attachments ?? [];
  const inputs = all.filter((a) => a.kind === 'input');
  const evidence = all.filter((a) => a.kind === 'evidence');

  const send = async (files: File[]) => {
    for (const f of files) {
      setSending({ name: f.name, done: 0 });
      const ok = await act(() => uploadFile(task.id, f, (done) => setSending({ name: f.name, done })));
      if (!ok) break;
    }
    setSending(null);
  };
  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    setOver(false);
    if (mayChange && ev.dataTransfer.files.length) void send([...ev.dataTransfer.files]);
  };
  const onPaste = (ev: ClipboardEvent) => {
    const files = [...ev.clipboardData.files];
    if (!mayChange || !files.length) return;
    ev.preventDefault();
    // A pasted screenshot has no name of its own.
    void send(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}${i ? `-${i + 1}` : ''}.png`, { type: f.type }))));
  };
  useEffect(() => {
    if (!open) return;
    const close = (ev: KeyboardEvent) => ev.key === 'Escape' && (ev.stopImmediatePropagation(), setOpen(null));
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [open]);

  const lightbox = open && (
    <div className="tf-lightbox" role="dialog" aria-label={open.a.name} onClick={() => setOpen(null)} data-esc-first>
      <img src={open.url} alt={open.a.caption ?? open.a.name} onClick={(ev) => ev.stopPropagation()} />
      <div className="tf-lightbox-bar" onClick={(ev) => ev.stopPropagation()}>
        <span className="strong truncate">{open.a.name}</span>
        {open.a.caption && <span className="muted truncate">{open.a.caption}</span>}
        <span className="grow" />
        <Button small onClick={() => void act(() => download(task.id, open.a))}>
          Download
        </Button>
        <Button small variant="ghost" onClick={() => setOpen(null)}>
          Close
        </Button>
      </div>
    </div>
  );

  if (only === 'evidence') {
    if (!evidence.length) return null;
    return (
      <div>
        <div className="section-title">Left by the employee to look at</div>
        <div className="tf-grid">
          {evidence.map((a) => (
            <FileCard key={a.id} task={task} a={a} mayChange={mayChange} onOpen={(x, url) => setOpen({ a: x, url })} />
          ))}
        </div>
        {lightbox}
      </div>
    );
  }

  return (
    <div className={`tf-box${over ? ' tf-over' : ''}`} onDragOver={(ev) => mayChange && (ev.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={onDrop} onPaste={onPaste} tabIndex={mayChange ? 0 : undefined} aria-label="Files on this task">
      <div className="row" style={{ gap: 8 }}>
        <div className="section-title grow" style={{ margin: 0 }}>
          Files{all.length ? ` (${all.length})` : ''}
        </div>
        {mayChange && (
          <>
            <input ref={input} type="file" multiple hidden onChange={(ev) => (void send([...(ev.target.files ?? [])]), (ev.target.value = ''))} />
            <Button small disabled={!!sending} onClick={() => input.current?.click()} title="Pictures, documents, logs — up to 100 MB each. You can also drop files here, or click here and paste a screenshot.">
              Attach files…
            </Button>
          </>
        )}
      </div>
      {sending && (
        <div className="small muted">
          Sending {sending.name}… {Math.round(sending.done * 100)}%
        </div>
      )}
      {inputs.length > 0 && (
        <div className="tf-grid">
          {inputs.map((a) => (
            <FileCard key={a.id} task={task} a={a} mayChange={mayChange} onOpen={(x, url) => setOpen({ a: x, url })} />
          ))}
        </div>
      )}
      {evidence.length > 0 && (
        <>
          <div className="small muted">Left by the employee as evidence:</div>
          <div className="tf-grid">
            {evidence.map((a) => (
              <FileCard key={a.id} task={task} a={a} mayChange={mayChange} onOpen={(x, url) => setOpen({ a: x, url })} />
            ))}
          </div>
        </>
      )}
      {all.length === 0 && !sending && (
        <div className="small faint">
          {mayChange ? 'Nothing attached. A picture of the problem, a mock-up or a document goes to the employee with the task — they open it and see it. Drop files here, or paste a screenshot.' : 'Nothing attached.'}
        </div>
      )}
      {lightbox}
    </div>
  );
}

/** Files chosen for a task that does not exist yet (the New task window). */
export function PendingFiles({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const add = (more: File[]) => onChange([...files, ...more.filter((f) => f.size > 0 && f.size <= MAX_FILE_BYTES)]);
  return (
    <div
      className="tf-box"
      onDragOver={(ev) => ev.preventDefault()}
      onDrop={(ev) => (ev.preventDefault(), add([...ev.dataTransfer.files]))}
      onPaste={(ev) => ev.clipboardData.files.length && (ev.preventDefault(), add([...ev.clipboardData.files].map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${Date.now()}.png`, { type: f.type })))))}
      tabIndex={0}
      aria-label="Files for this task"
    >
      <div className="row" style={{ gap: 8 }}>
        <span className="small grow muted">{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} go to the employee with the task` : 'Pictures and documents for the employee: a screenshot of the problem, a mock-up, a specification. Drop them here or paste a screenshot.'}</span>
        <input ref={input} type="file" multiple hidden onChange={(ev) => (add([...(ev.target.files ?? [])]), (ev.target.value = ''))} />
        <Button small onClick={() => input.current?.click()}>
          Attach files…
        </Button>
      </div>
      {files.map((f, i) => (
        <div key={`${f.name}-${i}`} className="row small" style={{ gap: 8 }}>
          <span className="truncate grow">{f.name}</span>
          <span className="faint">{size(f.size)}</span>
          <button type="button" className="tf-link tf-link-danger" onClick={() => onChange(files.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────────── pictures, to look at ─────────────────────────────

/** Is this file a picture the window can show? */
export const isPicture = (a: TaskAttachment): boolean => SHOWN.test(a.mime);

function Picture({ taskId, a, onOpen }: { taskId: string; a: TaskAttachment; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    urlOf(taskId, a).then(
      (u) => live && setUrl(u),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [taskId, a]);
  return (
    <button type="button" className="tp-pic" onClick={onOpen} title={`${a.caption ?? a.name} — click to enlarge`} aria-label={`Enlarge ${a.name}`} data-picture={a.name}>
      {failed ? <span className="small muted">could not be loaded</span> : url ? <img src={url} alt={a.caption ?? a.name} loading="lazy" /> : <span className="small faint">loading…</span>}
      <span className="tp-cap">{a.caption ?? a.name}</span>
    </button>
  );
}

/** One picture large, over everything: arrows (and the arrow keys) go to the next and the one before, Escape closes. */
function Viewer({ taskId, list, at, onAt, onClose }: { taskId: string; list: TaskAttachment[]; at: number; onAt: (i: number) => void; onClose: () => void }) {
  const a = list[at]!;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    urlOf(taskId, a).then(
      (u) => live && setUrl(u),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [taskId, a]);
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
      else if (ev.key === 'ArrowRight') onAt((at + 1) % list.length);
      else if (ev.key === 'ArrowLeft') onAt((at + list.length - 1) % list.length);
      else return;
      ev.preventDefault();
      // Nobody after this one hears the key: the window under the picture listens for Escape on the same target, and
      // whether it hears it before or after this depends on which of the two was registered last (the window registers
      // again whenever it is drawn again) — heard after, with the picture already gone, it closed the task as well.
      ev.stopImmediatePropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [at, list.length, onAt, onClose]);
  return (
    <div className="tf-lightbox" role="dialog" aria-label={a.name} onClick={onClose} data-viewer={a.name} data-esc-first>
      {list.length > 1 && (
        <button type="button" className="tp-nav tp-prev" aria-label="The picture before" onClick={(ev) => (ev.stopPropagation(), onAt((at + list.length - 1) % list.length))}>
          ‹
        </button>
      )}
      {url ? <img src={url} alt={a.caption ?? a.name} onClick={(ev) => ev.stopPropagation()} /> : <span className="muted">loading…</span>}
      {list.length > 1 && (
        <button type="button" className="tp-nav tp-next" aria-label="The next picture" onClick={(ev) => (ev.stopPropagation(), onAt((at + 1) % list.length))}>
          ›
        </button>
      )}
      <div className="tf-lightbox-bar" onClick={(ev) => ev.stopPropagation()}>
        <span className="strong truncate">{a.caption ?? a.name}</span>
        <span className="muted truncate">
          {a.caption ? `${a.name} · ` : ''}
          {a.addedBy.name}
          {list.length > 1 ? ` · ${at + 1} of ${list.length}` : ''}
        </span>
        <span className="grow" />
        <Button small onClick={() => void act(() => download(taskId, a))}>
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
 * Pictures of a task, shown as pictures: large enough to tell what is on them, each with what it shows, and a click
 * enlarges one — from there the arrows go through the rest. `fold`: how many are shown before "Show all".
 */
export function Pictures({ taskId, list, fold }: { taskId: string; list: TaskAttachment[]; fold?: number }) {
  const [at, setAt] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  if (!list.length) return null;
  const shown = fold && !all ? list.slice(0, fold) : list;
  return (
    <div className="tp-wrap">
      <div className="tp-grid" data-pictures={list.length}>
        {shown.map((a) => (
          <Picture key={a.id} taskId={taskId} a={a} onOpen={() => setAt(list.indexOf(a))} />
        ))}
      </div>
      {shown.length < list.length && (
        <button type="button" className="tk-link" onClick={() => setAll(true)}>
          Show all {list.length} pictures
        </button>
      )}
      {at !== null && list[at] && <Viewer taskId={taskId} list={list} at={at} onAt={setAt} onClose={() => setAt(null)} />}
    </div>
  );
}

/**
 * A file of a task that is not a picture, as a name to click. One that can be read (text, Markdown, JSON, a log, a
 * patch) opens in the window; anything else is downloaded.
 */
export function FileLinks({ taskId, list }: { taskId: string; list: TaskAttachment[] }) {
  const [open, setOpen] = useState<TaskAttachment | null>(null);
  if (!list.length) return null;
  const page = open ? isPageFile(open.name) : false;
  const reading = open && !page ? readableAs(open.name, open.mime, open.size) : null;
  const video = open ? !!playableAs(open.name, open.mime) : false;
  return (
    <div className="tp-docs" data-file-links={list.length}>
      {list.map((a) => {
        const reads = isPageFile(a.name) || !!readableAs(a.name, a.mime, a.size);
        const plays = playableAs(a.name, a.mime);
        return (
          <button key={a.id} type="button" className={`tp-doc tp-doc-${familyOf(a.name, a.mime)}`} title={`${a.caption ?? a.name} · ${size(a.size)} — ${plays ? 'play it here' : reads ? 'open it here' : 'download'}`} onClick={() => (reads || plays ? setOpen(a) : void act(() => download(taskId, a)))} data-file={a.name} data-file-reads={reads ? 'yes' : plays ?? 'no'}>
            <span className="tf-ext">{(a.name.split('.').pop() ?? 'file').slice(0, 5)}</span>
            <span className="truncate">{a.name}</span>
            <span className="faint">{size(a.size)}</span>
            <span className="tp-doc-does">{plays ? '▶ Play' : reads ? 'Open' : 'Download'}</span>
          </button>
        );
      })}
      {open && video && <VideoViewer audio={playableAs(open.name, open.mime) === 'audio'} name={open.name} note={open.caption ? `${open.caption} · ${open.addedBy.name}` : open.addedBy.name} size={size(open.size)} load={() => apiBlob(`/tasks/${taskId}/attachments/${open.id}`)} onDownload={() => void act(() => download(taskId, open))} onClose={() => setOpen(null)} />}
      {open && page && <PageViewer name={open.name} note={open.caption ? `${open.caption} · ${open.addedBy.name}` : open.addedBy.name} ticket={() => api<{ url: string }>('POST', `/tasks/${taskId}/attachments/${open.id}/page`, {})} load={() => apiBlob(`/tasks/${taskId}/attachments/${open.id}`)} onDownload={() => void act(() => download(taskId, open))} onClose={() => setOpen(null)} />}
      {open && reading && <TextViewer name={open.name} note={open.caption ? `${open.caption} · ${open.addedBy.name}` : open.addedBy.name} as={reading} load={() => apiBlob(`/tasks/${taskId}/attachments/${open.id}`)} onDownload={() => void act(() => download(taskId, open))} onClose={() => setOpen(null)} />}
    </div>
  );
}
