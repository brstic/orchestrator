import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const limit = 256 * 1024;
const privateName = /^(?:\.|.*\.(?:pem|key|p12|pfx)$|.*(?:credential|secret|password|token|auth\.json).*)/i;

export async function runCodexFiles(specPath: string): Promise<void> {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as { cwd: string; fileDeny?: string[] };
  const root = fs.realpathSync(spec.cwd);
  const deny = spec.fileDeny ?? [];
  const canRead = !deny.some((rule) => /^(?:read|glob|grep|ls|mcp__workspace)(?:\b|_)/i.test(rule.trim()));
  const canWrite = !deny.some((rule) => /^(?:write|edit|multiedit|notebookedit|apply_patch|mcp__workspace)(?:\b|_)/i.test(rule.trim()));
  const names = ['list_files', 'read_file', 'write_file'].filter((name) => name === 'write_file' ? canWrite : canRead);
  const tools = names.map((name) => ({
    name,
    description: name === 'list_files' ? 'List files in a workspace directory. Use "." for the selected workspace root.'
      : name === 'read_file' ? 'Read a UTF-8 text file in the selected workspace.'
        : 'Create or replace a UTF-8 text file in the selected workspace. Parent directory must exist.',
    annotations: { readOnlyHint: name !== 'write_file', destructiveHint: name === 'write_file', openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, ...(name === 'write_file' ? { content: { type: 'string' } } : {}) },
      required: name === 'write_file' ? ['path', 'content'] : ['path'],
      additionalProperties: false,
    },
  }));

  function resolve(value: unknown, missingLast: boolean): string {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')) throw Error('Use a workspace-relative path.');
    const segments = value === '.' ? [] : value.split('/');
    let current = root;
    for (const [i, segment] of segments.entries()) {
      if (privateName.test(segment) || !segment) throw Error('This path is outside the accessible workspace files.');
      current = path.join(current, segment);
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
      return fs.readdirSync(file, { withFileTypes: true }).filter((entry) => !privateName.test(entry.name) && (entry.isDirectory() || entry.isFile())).slice(0, 500)
        .map((entry) => entry.name + (entry.isDirectory() ? '/' : '')).join('\n') || '(empty)';
    }
    if (name === 'read_file') {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw Error('Expected an unlinked regular file up to 256 KiB.');
        const bytes = Buffer.alloc(limit + 1);
        const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (count > limit || bytes.subarray(0, count).includes(0)) throw Error('Expected a text file up to 256 KiB.');
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
      } finally { fs.closeSync(fd); }
    }
    if (file === root || typeof args.content !== 'string' || Buffer.byteLength(args.content) > limit) throw Error('Expected a file and up to 256 KiB of text.');
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.nlink !== 1)) throw Error('Only regular files may be replaced.');
    const temporary = path.join(path.dirname(file), `.orch-codex-${randomUUID()}`);
    try {
      fs.writeFileSync(temporary, args.content, { flag: 'wx', mode: existing ? existing.mode & 0o777 : 0o644 });
      if (resolve(args.path, true) !== file) throw Error('Workspace path changed.');
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return `Wrote ${args.path}`;
  }

  for await (const line of readline.createInterface({ input: process.stdin })) {
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request?.id === undefined) continue;
    const send = (result: unknown) => console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...result as object }));
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
        try { text = call(request.params?.name, request.params?.arguments ?? {}); }
        catch (error) { text = (error as Error).message; isError = true; }
        send({ result: { content: [{ type: 'text', text }], isError } });
        break;
      }
      case 'ping': send({ result: {} }); break;
      default: send({ error: { code: -32601, message: 'Method not found' } });
    }
  }
}
