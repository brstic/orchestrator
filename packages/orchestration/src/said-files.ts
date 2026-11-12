/**
 * Files said to an employee: the screenshot somebody pastes into the conversation with "look at this", a document
 * dropped beside a question. Not a task's files (`attachments.ts`): nothing is tracked, nothing is evidence, and they
 * are not kept — they belong to one message.
 *
 * The way of a file: the window sends it to the office in pieces; when the message is sent, the office copies each
 * file to the machine the employee's session runs on (the host agent's own folder, outside every repository, where
 * every session may read) and writes the paths under the message, so Claude Code opens them with its Read tool — an
 * image opened that way is seen. The office keeps its copy for a few days so the conversation can still show the
 * picture, then drops it.
 *
 * Read `docs/ATTACHMENTS.md` ("Files in a conversation") before changing this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { newId, type Employee, type SaidFile } from '@orchestrator/contracts';
import { MAX_FILE_BYTES, isImage, mimeOf, safeName } from './attachments.ts';
import { EngineError, type Core } from './core.ts';

/** How many files go with one message. */
export const MAX_SAID_FILES = 10;
/** How long the office keeps its copy of a file that was said, for the conversation to show it. */
export const SAID_KEEP_MS = 7 * 24 * 3600_000;
/** Files begun and never sent with a message are given up after this long. */
const UNSENT_MS = 60 * 60_000;
const CHUNK = 1024 * 1024;
const ID = /^[A-Za-z0-9-]+$/;

interface Held {
  employeeId: string;
  file: SaidFile;
  path: string;
  received: number;
  touched: number;
  /** Whose it is: only the one who began a file adds to it and sends it. */
  by: string;
}

export class SaidFiles {
  private core: Core;
  private dir: string | null;
  /** Files on their way, and files that are whole and wait for their message. */
  private held = new Map<string, Held>();
  private swept = Date.now();

  constructor(core: Core, dir: string | null) {
    this.core = core;
    this.dir = dir;
  }

  available(): boolean {
    return !!this.dir;
  }

  private fileOf(employeeId: string, id: string): string {
    if (!this.dir) throw new EngineError('this office keeps no files');
    if (!ID.test(employeeId) || !ID.test(id)) throw new EngineError('no such file', 404);
    return path.join(this.dir, employeeId, id);
  }

  /** Begin a file for a message to this employee. The bytes follow in pieces (`append`). */
  begin(employeeId: string, input: { name: string; size: number }, by: string): SaidFile {
    const employee = this.core.employees.require(employeeId);
    const size = Number(input.size);
    if (!Number.isInteger(size) || size <= 0) throw new EngineError('the file is empty');
    if (size > MAX_FILE_BYTES) throw new EngineError(`the file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB; put it on their machine and name its path instead`);
    this.forget();
    if ([...this.held.values()].filter((h) => h.employeeId === employee.id && h.by === by).length >= MAX_SAID_FILES * 2) throw new EngineError('too many files are waiting to be sent to them; send the message, or wait a little');
    const name = safeName(input.name);
    const file: SaidFile = { id: newId(), name, mime: mimeOf(name), size };
    const where = this.fileOf(employee.id, file.id);
    fs.mkdirSync(path.dirname(where), { recursive: true, mode: 0o700 });
    fs.writeFileSync(where, '', { mode: 0o600 });
    this.held.set(file.id, { employeeId: employee.id, file, path: where, received: 0, touched: Date.now(), by });
    return file;
  }

  append(employeeId: string, id: string, offset: number, data: Buffer, by: string): { received: number; done: boolean } {
    const h = this.held.get(id);
    if (!h || h.employeeId !== employeeId || h.by !== by) throw new EngineError('no such upload (it may have been given up); attach the file again', 404);
    if (offset !== h.received) throw new EngineError(`the next piece starts at ${h.received}, not ${offset}`, 409);
    if (h.received + data.length > h.file.size) throw new EngineError('more was sent than the file was said to hold');
    fs.appendFileSync(h.path, data);
    h.received += data.length;
    h.touched = Date.now();
    return { received: h.received, done: h.received >= h.file.size };
  }

  /** Give up files that were begun and never sent, and drop the office's copies of files said long enough ago. */
  private forget(): void {
    const now = Date.now();
    // (And once an hour, while files come and go: what was said long enough ago.)
    if (now - this.swept > 3600_000) {
      this.swept = now;
      try {
        this.sweep(now);
      } catch {
        /* a file somebody is reading: next time */
      }
    }
    for (const [id, h] of this.held) {
      if (now - h.touched <= UNSENT_MS) continue;
      this.held.delete(id);
      fs.rmSync(h.path, { force: true });
    }
  }

  /** At start, and once a day: what was said more than a few days ago is no longer kept (nor what was never sent before a restart). */
  sweep(now = Date.now()): number {
    if (!this.dir || !fs.existsSync(this.dir)) return 0;
    let removed = 0;
    for (const employeeId of fs.readdirSync(this.dir)) {
      const folder = path.join(this.dir, employeeId);
      if (!fs.statSync(folder).isDirectory()) continue;
      for (const id of fs.readdirSync(folder)) {
        if (this.held.has(id)) continue;
        const file = path.join(folder, id);
        // (A file with no message is one whose upload a restart cut short: nothing lists it.)
        const said = this.core.messages.find((m) => m.toEmployeeId === employeeId && !!m.files?.some((f) => f.id === id));
        if (said && now - fs.statSync(file).mtimeMs <= SAID_KEEP_MS) continue;
        fs.rmSync(file, { force: true });
        removed++;
      }
      if (!fs.readdirSync(folder).length) fs.rmSync(folder, { recursive: true, force: true });
    }
    return removed;
  }

  /**
   * The message is being sent: copy its files to the employee's machine and say where they are there. Throws, leaving
   * nothing sent, when a file is not whole or the machine cannot be reached — a message that says "look at this" must
   * not arrive without the thing to look at.
   */
  async deliver(employee: Employee, ids: string[], by: string): Promise<{ files: SaidFile[]; lines: string[] }> {
    if (!ids.length) return { files: [], lines: [] };
    if (ids.length > MAX_SAID_FILES) throw new EngineError(`at most ${MAX_SAID_FILES} files go with one message`);
    const mine = ids.map((id) => {
      const h = this.held.get(String(id));
      if (!h || h.employeeId !== employee.id || h.by !== by) throw new EngineError('one of the files is no longer here; attach it again', 404);
      if (h.received < h.file.size) throw new EngineError(`${h.file.name} has not arrived whole yet; wait a moment and send again`, 409);
      return h;
    });
    const hostId = this.core.runningSessionOf(employee.id)?.hostId ?? employee.hostId;
    if (!hostId || !this.core.agents.isOnline(hostId)) throw new EngineError(`${employee.name}'s machine is not in the office right now, so the files cannot reach them. Send the words alone, or wait until it is back.`);
    const lines: string[] = [];
    for (const h of mine) {
      // A name of its own on the machine: two screenshots are both "screenshot.png".
      const name = `${h.file.id.slice(0, 8)}-${h.file.name}`;
      let where = '';
      const fd = fs.openSync(h.path, 'r');
      try {
        for (let offset = 0; offset < h.file.size; offset += CHUNK) {
          const buf = Buffer.alloc(Math.min(CHUNK, h.file.size - offset));
          fs.readSync(fd, buf, 0, buf.length, offset);
          const res = await this.core.agents.rpc<{ path: string }>(hostId, { method: 'files.put', params: { folder: 'said', name, offset, dataBase64: buf.toString('base64'), last: offset + buf.length >= h.file.size } }, 30000).catch((e) => {
            throw new EngineError(`${h.file.name} could not be put on ${employee.name}'s machine: ${(e as Error).message}`);
          });
          where = res.path;
        }
      } finally {
        fs.closeSync(fd);
      }
      lines.push(`- ${where}${isImage(h.file.mime) ? ' (an image: you will see it)' : ''}`);
    }
    for (const h of mine) {
      this.held.delete(h.file.id);
      // From now on the copy is kept only for the conversation to show, counted from when it was said.
      fs.utimesSync(h.path, new Date(), new Date());
    }
    return { files: mine.map((h) => h.file), lines };
  }

  /** The words an employee gets under the message. */
  static note(lines: string[]): string {
    return lines.length ? `\n\nFiles that go with this — open ${lines.length === 1 ? 'it' : 'each'} with the Read tool before you answer:\n${lines.join('\n')}` : '';
  }

  /** Where a file that was said is, for showing it in the conversation — while the office still has it. */
  open(employeeId: string, id: string): { file: SaidFile; path: string } {
    const message = this.core.messages.find((m) => m.toEmployeeId === employeeId && !!m.files?.some((f) => f.id === id));
    const file = message?.files?.find((f) => f.id === id);
    const where = this.fileOf(employeeId, id);
    if (!file || !fs.existsSync(where)) throw new EngineError('the office no longer keeps this file', 404);
    return { file, path: where };
  }
}
