/**
 * Files on tasks: what a person attaches for the employee to work from (a picture of the bug, a specification), and
 * what an employee leaves as evidence of the work (a screenshot of the page they built, a log, a report).
 *
 * The bytes live in the office's data folder (`files/<task id>/<attachment id>`); the task carries only the list
 * (`Task.attachments`). A file meant for the employee is copied to the machine their session runs on, into a folder
 * of the host agent outside every repository, and its path is put in the task — Claude Code opens it with its Read
 * tool, and an image opened that way is *seen* by the model.
 *
 * Read `docs/ATTACHMENTS.md` before changing this.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newId, nowIso, truncate, type Employee, type Task, type TaskAttachment } from '@orchestrator/contracts';
import { EngineError, type Core } from './core.ts';
import type { Engine } from './engine.ts';

/** One file, at most. Larger things (a database dump, a video) belong on the machine, named in the task. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** (Thirty until 2026-11-12: one long task with a picture per step was full, and its employee went back to naming paths nobody else could open.) */
export const MAX_FILES_PER_TASK = 200;
/** What goes to and from a machine in one message (the link carries 8 MB at most; base64 adds a third). */
const CHUNK = 1024 * 1024;

const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', log: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html', svg: 'image/svg+xml', zip: 'application/zip', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg' };

export const mimeOf = (name: string): string => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
export const isImage = (mime: string): boolean => IMAGE.test(mime);

/** A file's name as it may stand in a folder: no path, no control characters, not hidden, not empty. */
export function safeName(raw: string): string {
  const base = String(raw ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  return clean || 'file';
}

interface Upload {
  taskId: string;
  attachment: TaskAttachment;
  file: string;
  received: number;
  touched: number;
}

export class Attachments {
  private core: Core;
  private eng: Engine;
  private dir: string | null;
  private uploads = new Map<string, Upload>();

  constructor(core: Core, eng: Engine, dir: string | null) {
    this.core = core;
    this.eng = eng;
    this.dir = dir;
  }

  available(): boolean {
    return !!this.dir;
  }

  private fileOf(taskId: string, id: string): string {
    if (!this.dir) throw new EngineError('this office keeps no files');
    if (!/^[A-Za-z0-9-]+$/.test(taskId) || !/^[A-Za-z0-9-]+$/.test(id)) throw new EngineError('no such file', 404);
    return path.join(this.dir, taskId, id);
  }

  list(task: Task): TaskAttachment[] {
    return task.attachments ?? [];
  }

  /** Where one attachment's bytes are, for sending to whoever may see the task. */
  open(taskId: string, id: string): { attachment: TaskAttachment; file: string } {
    const task = this.core.tasks.require(taskId);
    const attachment = this.list(task).find((a) => a.id === id);
    if (!attachment) throw new EngineError('no such file on this task', 404);
    const file = this.fileOf(taskId, id);
    if (!fs.existsSync(file)) throw new EngineError('the file is no longer in the office', 404);
    return { attachment, file };
  }

  /**
   * Begin adding a file to a task (a person in the office). The bytes follow in pieces (`append`), so that a large
   * file passes through any proxy in front of the office.
   */
  begin(taskId: string, input: { name: string; mime?: string | null; size: number; caption?: string | null }, by: TaskAttachment['addedBy']): TaskAttachment {
    const task = this.core.tasks.require(taskId);
    const size = Number(input.size);
    if (!Number.isInteger(size) || size <= 0) throw new EngineError('the file is empty');
    if (size > MAX_FILE_BYTES) throw new EngineError(`the file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB; put it on the machine and name its path in the task instead`);
    for (const [id, u] of this.uploads) if (Date.now() - u.touched > 10 * 60_000) this.abandon(id);
    // Files on their way count: otherwise any number could be begun while the task still holds few.
    const onTheirWay = [...this.uploads.values()].filter((u) => u.taskId === taskId).length;
    if (this.list(task).length + onTheirWay >= MAX_FILES_PER_TASK) throw new EngineError(`a task holds at most ${MAX_FILES_PER_TASK} files`);
    const name = this.freeName(task, safeName(input.name));
    const attachment: TaskAttachment = { id: newId(), name, mime: mimeOf(name), size, kind: 'input', caption: truncate(String(input.caption ?? '').trim(), 300) || null, addedBy: by, addedAt: nowIso(), sha256: null, paths: {} };
    const file = this.fileOf(taskId, attachment.id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, '', { mode: 0o600 });
    this.uploads.set(attachment.id, { taskId, attachment, file, received: 0, touched: Date.now() });
    return attachment;
  }

  /** The next piece of a file that was begun. The last one puts the file on the task and sends it to the employee who has it. */
  append(taskId: string, id: string, offset: number, data: Buffer): { received: number; done: boolean; attachment: TaskAttachment } {
    const u = this.uploads.get(id);
    if (!u || u.taskId !== taskId) throw new EngineError('no such upload (it may have been given up after ten quiet minutes); start again', 404);
    if (offset !== u.received) throw new EngineError(`the next piece starts at ${u.received}, not ${offset}`, 409);
    if (u.received + data.length > u.attachment.size) throw new EngineError('more was sent than the file was said to hold');
    fs.appendFileSync(u.file, data);
    u.received += data.length;
    u.touched = Date.now();
    if (u.received < u.attachment.size) return { received: u.received, done: false, attachment: u.attachment };
    this.uploads.delete(id);
    return { received: u.received, done: true, attachment: this.add(taskId, u.attachment, u.file) };
  }

  private abandon(id: string): void {
    const u = this.uploads.get(id);
    this.uploads.delete(id);
    if (u) fs.rmSync(u.file, { force: true });
  }

  private freeName(task: Task, name: string): string {
    const taken = new Set(this.list(task).map((a) => a.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let i = 2; ; i++) if (!taken.has(`${stem}-${i}${ext}`.toLowerCase())) return `${stem}-${i}${ext}`;
  }

  /**
   * Files in the store that no task lists: uploads that were begun and never finished before the office was
   * restarted (what is being uploaded is remembered only while it runs). Removed when the office starts.
   */
  sweep(): number {
    if (!this.dir || !fs.existsSync(this.dir)) return 0;
    let removed = 0;
    for (const taskId of fs.readdirSync(this.dir)) {
      const folder = path.join(this.dir, taskId);
      if (!fs.statSync(folder).isDirectory()) continue;
      const task = this.core.tasks.get(taskId);
      const listed = new Set((task?.attachments ?? []).map((a) => a.id));
      for (const id of fs.readdirSync(folder)) {
        if (listed.has(id) || this.uploads.has(id)) continue;
        fs.rmSync(path.join(folder, id), { force: true, recursive: true });
        removed++;
      }
      if (!fs.readdirSync(folder).length) fs.rmSync(folder, { recursive: true, force: true });
    }
    return removed;
  }

  /** A complete file joins its task. */
  private add(taskId: string, attachment: TaskAttachment, file: string): TaskAttachment {
    const task = this.core.tasks.require(taskId);
    if (this.list(task).length >= MAX_FILES_PER_TASK) {
      fs.rmSync(file, { force: true });
      throw new EngineError(`a task holds at most ${MAX_FILES_PER_TASK} files`);
    }
    attachment.sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    task.attachments = [...this.list(task), attachment];
    task.history.push({ ts: nowIso(), status: task.status, note: `${attachment.kind === 'evidence' ? 'Evidence added' : 'File attached'}: ${attachment.name}${attachment.caption ? ` — ${attachment.caption}` : ''}`, by: attachment.addedBy.name });
    task.updatedAt = nowIso();
    this.core.put('task', task);
    this.core.event({ type: 'task.attachment_added', source: attachment.addedBy.kind === 'employee' ? 'mcp' : 'owner', summary: `${attachment.addedBy.name} ${attachment.kind === 'evidence' ? 'left' : 'attached'} ${attachment.name} ${attachment.kind === 'evidence' ? 'as evidence on' : 'to'} ${task.key}`, taskId, projectId: task.projectId, employeeId: task.assigneeId, data: { key: task.key, attachmentId: attachment.id, name: attachment.name, mime: attachment.mime, size: attachment.size, kind: attachment.kind } });
    // Somebody is working on it right now: the file goes to their machine, and they are told.
    if (attachment.kind === 'input' && task.status === 'IN_PROGRESS' && task.assigneeId) {
      const employee = this.core.employees.get(task.assigneeId);
      if (employee) {
        void this.deliver(task, employee).then((lines) => {
          const line = lines.find((l) => l.id === attachment.id);
          if (line) this.eng.comms.sendMessage({ from: { kind: 'system', id: null, name: 'the office' }, toEmployeeId: employee.id, kind: 'system', taskId: task.id, body: `${attachment.addedBy.name} attached a file to ${task.key}: ${line.path}${attachment.caption ? ` — ${attachment.caption}` : ''}. Open it with the Read tool${isImage(attachment.mime) ? ' (it is an image: you will see it)' : ''}.` });
        });
      }
    }
    return attachment;
  }

  remove(taskId: string, id: string, actor: string): void {
    const task = this.core.tasks.require(taskId);
    const attachment = this.list(task).find((a) => a.id === id);
    if (!attachment) throw new EngineError('no such file on this task', 404);
    task.attachments = this.list(task).filter((a) => a.id !== id);
    task.history.push({ ts: nowIso(), status: task.status, note: `File removed: ${attachment.name}`, by: actor });
    this.core.put('task', task);
    fs.rmSync(this.fileOf(taskId, id), { force: true });
    this.core.audit(actor, 'task.attachment_removed', taskId, { name: attachment.name, kind: attachment.kind });
  }

  /** A task is gone: so are its files. */
  dropTask(taskId: string): void {
    if (!this.dir || !/^[A-Za-z0-9-]+$/.test(taskId)) return;
    fs.rmSync(path.join(this.dir, taskId), { recursive: true, force: true });
  }

  /**
   * Copy the files people attached to a task onto the machine of the employee who has it (once per machine), and say
   * where they are there. Nothing is copied into the repository: they land in the host agent's own folder.
   */
  async deliver(task: Task, employee: Employee): Promise<Array<{ id: string; name: string; path: string; caption: string | null; image: boolean }>> {
    const hostId = this.core.runningSessionOf(employee.id)?.hostId ?? employee.hostId;
    const out: Array<{ id: string; name: string; path: string; caption: string | null; image: boolean }> = [];
    if (!hostId || !this.dir) return out;
    let changed = false;
    for (const a of this.list(task).filter((x) => x.kind === 'input')) {
      let where = a.paths?.[hostId] ?? null;
      if (!where && this.core.agents.isOnline(hostId)) {
        try {
          const file = this.fileOf(task.id, a.id);
          const size = fs.statSync(file).size;
          const fd = fs.openSync(file, 'r');
          try {
            for (let offset = 0; offset < size || offset === 0; offset += CHUNK) {
              const buf = Buffer.alloc(Math.min(CHUNK, size - offset));
              fs.readSync(fd, buf, 0, buf.length, offset);
              const res = await this.core.agents.rpc<{ path: string }>(hostId, { method: 'files.put', params: { folder: task.key, name: a.name, offset, dataBase64: buf.toString('base64'), last: offset + buf.length >= size } }, 30000);
              where = res.path;
              if (size === 0) break;
            }
          } finally {
            fs.closeSync(fd);
          }
          a.paths = { ...(a.paths ?? {}), [hostId]: where! };
          changed = true;
        } catch (e) {
          this.core.log('warn', `sending ${a.name} of ${task.key} to ${this.core.hosts.get(hostId)?.name ?? hostId}: ${(e as Error).message}`);
          where = null;
        }
      }
      if (where) out.push({ id: a.id, name: a.name, path: where, caption: a.caption, image: isImage(a.mime) });
    }
    if (changed) this.core.put('task', task);
    return out;
  }

  /**
   * An employee leaves a file from their machine on a task as evidence: a screenshot of what they built, a report,
   * a log. The machine's agent reads it (only from the folders it is allowed in, and its own); the office keeps it.
   */
  /**
   * Take a file from the machine an employee's session runs on into `dest` here, in pieces. The machine decides what
   * may be read (its allowed folders, the agent's own, the temp folder). Returns the file's name there and its size.
   */
  async pull(employee: Employee, filePath: string, dest: string, cwdHint: string | null = null): Promise<{ name: string; size: number }> {
    const session = this.core.runningSessionOf(employee.id);
    const hostId = session?.hostId ?? employee.hostId;
    if (!hostId || !this.core.agents.isOnline(hostId)) throw new EngineError('your machine is not reachable by the office right now; try again shortly');
    const cwd = session?.cwd ?? cwdHint ?? employee.workingDir ?? null;
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest, '', { mode: 0o600 });
    let size = 0;
    let name = safeName(filePath);
    try {
      for (let offset = 0; ; ) {
        const res = await this.core.agents.rpc<{ dataBase64: string; size: number; name: string }>(hostId, { method: 'files.get', params: { path: filePath, cwd, sessionId: session?.id ?? null, offset, length: CHUNK } }, 30000);
        size = res.size;
        name = safeName(res.name);
        if (size > MAX_FILE_BYTES) throw new EngineError(`${name} is ${(size / 1024 / 1024).toFixed(1)} MB; a file given through the office is at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
        if (size === 0) throw new EngineError(`${name} is empty`);
        const buf = Buffer.from(res.dataBase64, 'base64');
        fs.appendFileSync(dest, buf);
        offset += buf.length;
        if (offset >= size || buf.length === 0) break;
      }
    } catch (e) {
      fs.rmSync(dest, { force: true });
      throw e instanceof EngineError ? e : new EngineError((e as Error).message);
    }
    return { name, size };
  }

  async attachFrom(task: Task, employee: Employee, filePath: string, caption: string | null): Promise<TaskAttachment> {
    if (!this.dir) throw new EngineError('this office keeps no files');
    if (this.list(task).length >= MAX_FILES_PER_TASK) throw new EngineError(`${task.key} already holds ${MAX_FILES_PER_TASK} files; remove one or leave this one out`);
    const id = newId();
    const file = this.fileOf(task.id, id);
    const pulled = await this.pull(employee, filePath, file, task.worktree);
    const size = pulled.size;
    let name = pulled.name;
    name = this.freeName(task, name);
    return this.add(task.id, { id, name, mime: mimeOf(name), size, kind: 'evidence', caption: truncate(String(caption ?? '').trim(), 300) || null, addedBy: { kind: 'employee', id: employee.id, name: employee.name }, addedAt: nowIso(), sha256: null, paths: {} }, file);
  }
}
