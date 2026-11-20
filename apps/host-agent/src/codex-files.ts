import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

/**
 * The file tools of a Codex employee (`codex-run` starts this as an MCP server over stdio). Codex itself has no shell
 * and writes only to a private scratch folder; this is the only way it reaches the folder it works in, so everything
 * it may not touch is refused here (tested in `test/codex-files.test.ts`):
 * - anything outside that folder — a parent (`..`), an absolute path, a link (symbolic or a second name of a file);
 * - hidden names and names that look like keys or credentials, at any depth;
 * - the office's own files on this machine (`officeRoots`: the agent's home, the server's), as for every employee
 *   (`HostAgent.officeFiles`) — and with no exception for the session's own folder, which holds its tokens;
 * - a tool a deny rule names: any rule for reading takes `list_files`/`read_file` away, any rule for editing
 *   `write_file` — the whole tool, also where the rule names only some paths (refusing more, never less).
 */

const LIMIT = 256 * 1024;
const PRIVATE_NAME = /^(?:\.|.*\.(?:pem|key|p12|pfx)$|.*(?:credential|secret|password|token|auth\.json).*)/i;
const READ_RULE = /^(?:read|glob|grep|ls|mcp__workspace)(?:\b|_)/i;
const EDIT_RULE = /^(?:write|edit|multiedit|notebookedit|apply_patch|mcp__workspace)(?:\b|_)/i;

export interface WorkspaceSpec {
  cwd: string;
  fileDeny?: string[];
  /** The office's own folders on this machine: never read, listed or written, wherever the working folder is. */
  officeRoots?: string[];
}

export interface WorkspaceTool {
  name: string;
  description: string;
  annotations: Record<string, boolean>;
  inputSchema: Record<string, unknown>;
}

const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

/** The tools as they are offered, and what calling one does (a refusal is thrown, with words for the model). */
export function workspaceTools(spec: WorkspaceSpec): { tools: WorkspaceTool[]; call: (name: string, args: Record<string, unknown>) => string } {
  const root = fs.realpathSync(spec.cwd);
  const office = (spec.officeRoots ?? []).flatMap((p) => {
    const resolved = path.resolve(p);
    try {
      return [...new Set([resolved, fs.realpathSync(resolved)])];
    } catch {
      return [resolved];
    }
  });
  const isOffice = (p: string) => office.some((o) => inside(p, o));
  if (isOffice(root)) throw Error("The working folder is inside the office's own files.");
  const deny = (spec.fileDeny ?? []).map((r) => r.trim());
  const canRead = !deny.some((rule) => READ_RULE.test(rule));
  const canWrite = !deny.some((rule) => EDIT_RULE.test(rule));
  const names = ['list_files', 'read_file', 'write_file'].filter((name) => (name === 'write_file' ? canWrite : canRead));
  const tools = names.map((name) => ({
    name,
    description:
      name === 'list_files'
        ? 'List files in a workspace directory. Use "." for the selected workspace root.'
        : name === 'read_file'
          ? 'Read a UTF-8 text file in the selected workspace.'
          : 'Create or replace a UTF-8 text file in the selected workspace. Parent directory must exist.',
    annotations: { readOnlyHint: name !== 'write_file', destructiveHint: name === 'write_file', openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, ...(name === 'write_file' ? { content: { type: 'string' } } : {}) },
      required: name === 'write_file' ? ['path', 'content'] : ['path'],
      additionalProperties: false,
    },
  }));

  /** The path inside the folder, every step of it checked on the disk (a missing last step only when writing). */
  function resolve(value: unknown, missingLast: boolean): string {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')) throw Error('Use a workspace-relative path.');
    const segments = value === '.' ? [] : value.split('/');
    let current = root;
    for (const [i, segment] of segments.entries()) {
      if (PRIVATE_NAME.test(segment) || !segment) throw Error('This path is outside the accessible workspace files.');
      current = path.join(current, segment);
      if (isOffice(current)) throw Error("This path is in the office's own files.");
      const info = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!info && missingLast && i === segments.length - 1) break;
      if (!info || info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw Error('Path unavailable or linked.');
      if (i < segments.length - 1 && !info.isDirectory()) throw Error('Parent path must be a directory.');
    }
    return current;
  }

  function call(name: string, args: Record<string, unknown>): string {
    if (!names.includes(name)) throw Error('Tool unavailable under workspace policy.');
    const file = resolve(args.path, name === 'write_file');
    if (name === 'list_files') {
      return (
        fs
          .readdirSync(file, { withFileTypes: true })
          .filter((entry) => !PRIVATE_NAME.test(entry.name) && (entry.isDirectory() || entry.isFile()) && !isOffice(path.join(file, entry.name)))
          .slice(0, 500)
          .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''))
          .join('\n') || '(empty)'
      );
    }
    if (name === 'read_file') {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || info.size > LIMIT) throw Error('Expected an unlinked regular file up to 256 KiB.');
        const bytes = Buffer.alloc(LIMIT + 1);
        const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (count > LIMIT || bytes.subarray(0, count).includes(0)) throw Error('Expected a text file up to 256 KiB.');
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
      } finally {
        fs.closeSync(fd);
      }
    }
    if (file === root || typeof args.content !== 'string' || Buffer.byteLength(args.content) > LIMIT) throw Error('Expected a file and up to 256 KiB of text.');
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.nlink !== 1)) throw Error('Only regular files may be replaced.');
    const temporary = path.join(path.dirname(file), `.orch-codex-${randomUUID()}`);
    try {
      fs.writeFileSync(temporary, args.content, { flag: 'wx', mode: existing ? existing.mode & 0o777 : 0o644 });
      // (Checked again just before: a step of the path made into a link meanwhile is refused.)
      if (resolve(args.path, true) !== file) throw Error('Workspace path changed.');
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return `Wrote ${args.path}`;
  }

  return { tools, call };
}

export async function runCodexFiles(specPath: string): Promise<void> {
  const { tools, call } = workspaceTools(JSON.parse(fs.readFileSync(specPath, 'utf8')) as WorkspaceSpec);
  for await (const line of readline.createInterface({ input: process.stdin })) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request?.id === undefined) continue;
    const send = (result: unknown) => console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(result as object) }));
    switch (request.method) {
      case 'initialize':
        send({ result: { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'workspace', version: '1.0.0' } } });
        break;
      case 'tools/list':
        send({ result: { tools } });
        break;
      case 'tools/call': {
        let text: string;
        let isError = false;
        try {
          text = call(request.params?.name, request.params?.arguments ?? {});
        } catch (error) {
          text = (error as Error).message;
          isError = true;
        }
        send({ result: { content: [{ type: 'text', text }], isError } });
        break;
      }
      case 'ping':
        send({ result: {} });
        break;
      default:
        send({ error: { code: -32601, message: 'Method not found' } });
    }
  }
}
