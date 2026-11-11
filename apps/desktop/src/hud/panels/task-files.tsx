import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { Task, TaskAttachment } from '@orchestrator/contracts';
import { Button } from '@orchestrator/ui';
import { api, apiBlob } from '../../lib/api.ts';
import { useAccess } from '../../lib/access.ts';
import { useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';

/**
 * Files on a task: what people attach for the employee (a picture of the bug, a mock-up, a document), and what the
 * employee leaves as evidence (a screenshot of the result). Pictures are shown; everything else is a download.
 */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
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
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 25 MB. Put it on the machine and name its path in the task instead.`);
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
  return (
    <div className="tf-file" data-attachment={a.name} data-kind={a.kind}>
      {SHOWN.test(a.mime) ? (
        <Thumb taskId={task.id} a={a} onOpen={(url) => onOpen(a, url)} />
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
    const close = (ev: KeyboardEvent) => ev.key === 'Escape' && (ev.stopPropagation(), setOpen(null));
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [open]);

  const lightbox = open && (
    <div className="tf-lightbox" role="dialog" aria-label={open.a.name} onClick={() => setOpen(null)}>
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
            <Button small disabled={!!sending} onClick={() => input.current?.click()} title="Pictures, documents, logs — up to 25 MB each. You can also drop files here, or click here and paste a screenshot.">
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
