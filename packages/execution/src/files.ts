import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Folders that never contain the documents an employee works from. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.orchestrator-worktrees', '.orchestrator-dev', 'Pods', '.gradle', '.idea']);

export interface DocFile {
  /** Path relative to the folder, with forward slashes. */
  path: string;
  size: number;
  modifiedAt: string;
}

export interface DocListing {
  root: string;
  files: DocFile[];
  /** True when the folder has more Markdown files than are listed. */
  truncated: boolean;
}

/**
 * The Markdown files in a folder and its subfolders: the notes, plans and
 * instructions an employee keeps next to their work. Read-only, bounded in
 * depth and count, and never follows symbolic links out of the folder.
 */
export async function listMarkdown(root: string, opts: { maxFiles?: number; maxDepth?: number } = {}): Promise<DocListing> {
  const maxFiles = opts.maxFiles ?? 400;
  const maxDepth = opts.maxDepth ?? 6;
  const files: DocFile[] = [];
  let truncated = false;
  async function walk(dir: string, depth: number): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Hidden folders are skipped, except the ones Claude Code itself keeps instructions in.
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.claude')) continue;
        if (depth < maxDepth) await walk(full, depth + 1);
      } else if (e.isFile() && /\.(md|markdown|mdx)$/i.test(e.name)) {
        try {
          const st = await fs.stat(full);
          files.push({ path: path.relative(root, full).split(path.sep).join('/'), size: st.size, modifiedAt: st.mtime.toISOString() });
        } catch {
          /* vanished meanwhile */
        }
      }
    }
  }
  await walk(root, 0);
  return { root, files, truncated };
}

/** Read one Markdown file from a folder. The path must stay inside the folder, also after resolving links. */
export async function readMarkdown(root: string, relative: string, maxBytes = 512 * 1024): Promise<{ path: string; content: string; truncated: boolean; modifiedAt: string }> {
  if (!/\.(md|markdown|mdx)$/i.test(relative)) throw new Error('only Markdown files can be read here');
  const rootReal = await fs.realpath(root);
  const target = path.resolve(rootReal, relative);
  const real = await fs.realpath(target).catch(() => {
    throw new Error(`no such file: ${relative}`);
  });
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error('that file is outside the folder');
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error('not a file');
  const handle = await fs.open(real, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    await handle.read(buf, 0, buf.length, 0);
    return { path: relative, content: buf.toString('utf8'), truncated: st.size > maxBytes, modifiedAt: st.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

export interface FolderEntry {
  name: string;
  path: string;
  /** A git repository lives here. */
  repo: boolean;
  /** Has a CLAUDE.md (a project Claude Code already knows). */
  claude: boolean;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  folders: FolderEntry[];
  /** This folder itself. */
  repo: boolean;
  home: string;
}

/** The subfolders of a folder, for choosing where an employee should live. Hidden folders are left out. */
export async function listFolders(dir: string): Promise<FolderListing> {
  const real = await fs.realpath(dir);
  const st = await fs.stat(real);
  if (!st.isDirectory()) throw new Error('not a folder');
  const exists = (p: string) => fs.access(p).then(
    () => true,
    () => false,
  );
  const entries = await fs.readdir(real, { withFileTypes: true });
  const names = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).slice(0, 500);
  const folders = await Promise.all(
    names.map(async (name) => {
      const p = path.join(real, name);
      const [repo, claude] = await Promise.all([exists(path.join(p, '.git')), exists(path.join(p, 'CLAUDE.md'))]);
      return { name, path: p, repo, claude };
    }),
  );
  const parent = path.dirname(real);
  return { path: real, parent: parent === real ? null : parent, folders, repo: await exists(path.join(real, '.git')), home: os.homedir() };
}

/**
 * A name a new folder may have: one piece of a path, visible in the folder list (not hidden), nothing a shell or a
 * terminal would read as something else. Returns the name as it will be used, or says why not.
 */
export function folderName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new Error('give the new folder a name');
  if (name.length > 100) throw new Error('a folder name has at most 100 characters');
  if (/[\/\\]/.test(name) || name === '.' || name === '..') throw new Error('a folder name is one name, not a path');
  if (name.startsWith('.')) throw new Error('a folder whose name starts with a dot is hidden and would not be listed');
  if (name.startsWith('-')) throw new Error('a folder name cannot start with a dash');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('a folder name cannot contain control characters');
  return name;
}

/** Make one new, empty folder inside an existing one (never more than one level, never over something that exists). */
export async function createFolder(parent: string, raw: unknown): Promise<{ path: string; name: string }> {
  const name = folderName(raw);
  const real = await fs.realpath(parent).catch(() => {
    throw new Error(`${parent} does not exist`);
  });
  if (!(await fs.stat(real)).isDirectory()) throw new Error(`${parent} is not a folder`);
  const target = path.join(real, name);
  try {
    await fs.mkdir(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`"${name}" already exists there`);
    throw new Error(`could not make "${name}": ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  return { path: target, name };
}
