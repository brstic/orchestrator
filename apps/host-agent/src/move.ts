import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MoveFetchBackParams, MoveFile, MoveFileName, MovePacked, MovePackParams, MoveUnpacked, MoveUnpackParams } from '@orchestrator/contracts';

/**
 * Moving an employee to another machine, the machine's half (`docs/MOVE.md`): the files of a move are made here
 * (`pack`), sent piece by piece through the office (`readPiece` / `writePiece`) and made into a folder and a
 * conversation again on the other machine (`unpack`, or `fetchBack` into the project a copy came from).
 *
 * A move's files are kept in `<agent home>/moves/<id>/`, nowhere else, and removed by `drop`.
 */

/** Made again by an install or a build, wherever they are: never taken along. */
export const ALWAYS_REBUILT = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.turbo', '.parcel-cache', '.pytest_cache', '.mypy_cache', '.gradle', 'Pods', '.orchestrator-worktrees', '.orchestrator-dev']);
/** Usually a build's output, but a name a project may use for its own files too: left out only where git ignores it. */
export const REBUILT_IF_IGNORED = new Set(['dist', 'build', 'out', 'target', 'coverage', '.cache', '.output']);
/** The most a move takes (its folder or bundle): more is a folder nobody meant to move. */
export const MOVE_LIMIT = 20 * 1024 ** 3;
export const PIECE = 2 * 1024 * 1024;
const FILES: MoveFileName[] = ['folder.tgz', 'repo.bundle', 'claude.tgz'];

const run = (cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 30 * 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${cmd} ${args[0] ?? ''} failed: ${String(stderr || error.message).trim().slice(0, 400)}`));
      else resolve(String(stdout));
    });
  });

/** Where Claude Code keeps the conversations of a folder: `<account>/projects/<the folder's real path, every other character a dash>`. */
export function claudeProjectDir(base: string, cwd: string): string {
  let real = path.resolve(cwd);
  try {
    real = fs.realpathSync(real);
  } catch {
    /* not there (yet): as written */
  }
  return path.join(base, 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'));
}

const sha256Of = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });

export const moveDir = (home: string, moveId: string): string => {
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(moveId)) throw new Error('not a move');
  return path.join(home, 'moves', moveId);
};

const fileOf = (home: string, moveId: string, name: string): string => {
  if (!FILES.includes(name as MoveFileName)) throw new Error(`not a file of a move: ${name}`);
  return path.join(moveDir(home, moveId), name);
};

/**
 * What of a folder is taken along: every file, folder and link, without the folders that are made again
 * (`ALWAYS_REBUILT`, and `REBUILT_IF_IGNORED` where git ignores them). Paths relative to the folder, `./`-led.
 */
export async function moveList(root: string): Promise<{ entries: string[]; skipped: string[]; bytes: number }> {
  const git = fs.existsSync(path.join(root, '.git'));
  const candidates: string[] = [];
  const entries: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  const walk = (rel: string) => {
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (ALWAYS_REBUILT.has(d.name)) {
          skipped.push(r);
          continue;
        }
        if (git && REBUILT_IF_IGNORED.has(d.name) && !r.startsWith('.git/')) {
          candidates.push(r);
          continue;
        }
        entries.push(`./${r}`);
        walk(r);
      } else if (d.isFile() || d.isSymbolicLink()) {
        entries.push(`./${r}`);
        if (d.isFile()) bytes += fs.statSync(path.join(root, r)).size;
        if (bytes > MOVE_LIMIT) throw new Error(`the folder is more than ${MOVE_LIMIT / 1024 ** 3} GB even without what an install or a build makes again`);
      }
    }
  };
  walk('');
  // (Asked of git in one go: which of these build-like folders it ignores.)
  if (candidates.length) {
    const ignored = await ignoredOf(root, candidates);
    for (const c of candidates) {
      if (ignored.has(c)) skipped.push(c);
      else {
        entries.push(`./${c}`);
        walk(c);
      }
    }
  }
  return { entries, skipped, bytes };
}

function ignoredOf(root: string, rels: string[]): Promise<Set<string>> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-C', root, 'check-ignore', '--stdin'], { timeout: 60_000 }, (_error, stdout) => {
      // (Exit 1 when none of them is ignored; what it printed is the answer either way.)
      resolve(new Set(String(stdout ?? '').split('\n').map((l) => l.trim().replace(/\/$/, '')).filter(Boolean)));
    });
    child.stdin?.end(rels.map((r) => `${r}/`).join('\n') + '\n');
  });
}

/** The files of a move, made here. */
export async function pack(home: string, p: MovePackParams, claudeBase: string): Promise<MovePacked> {
  const dir = moveDir(home, p.moveId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: MoveFile[] = [];
  let skipped: string[] = [];
  try {
    if (p.kind === 'bundle') {
      const out = path.join(dir, 'repo.bundle');
      await run('git', ['-C', p.path, 'bundle', 'create', out, '--all']);
      if (fs.statSync(out).size > MOVE_LIMIT) throw new Error(`the repository is more than ${MOVE_LIMIT / 1024 ** 3} GB`);
      files.push({ name: 'repo.bundle', size: fs.statSync(out).size, sha256: await sha256Of(out) });
    } else {
      const listed = await moveList(p.path);
      skipped = listed.skipped;
      const list = path.join(dir, 'list');
      fs.writeFileSync(list, listed.entries.join('\n') + '\n');
      const out = path.join(dir, 'folder.tgz');
      // (Each entry by itself: the folders that are left out are not taken in through their parent.)
      await run('tar', ['-czf', out, '-C', p.path, '--no-recursion', '-T', list]);
      files.push({ name: 'folder.tgz', size: fs.statSync(out).size, sha256: await sha256Of(out) });
    }
    let claudeFiles = 0;
    if (p.claude && p.claude.sessionIds.length) {
      const from = claudeProjectDir(claudeBase, p.claude.cwd);
      const stage = path.join(dir, 'claude-stage', 'claude');
      fs.mkdirSync(stage, { recursive: true });
      const take = (name: string) => {
        const src = path.join(from, name);
        if (!fs.existsSync(src)) return;
        fs.cpSync(src, path.join(stage, name), { recursive: true, dereference: false });
        claudeFiles++;
      };
      for (const id of p.claude.sessionIds) {
        if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) continue;
        take(`${id}.jsonl`);
        take(id);
      }
      // Claude Code's own memory of this folder (its `memory/`), when it keeps one.
      take('memory');
      if (claudeFiles) {
        const out = path.join(dir, 'claude.tgz');
        await run('tar', ['-czf', out, '-C', path.dirname(stage), 'claude']);
        files.push({ name: 'claude.tgz', size: fs.statSync(out).size, sha256: await sha256Of(out) });
      }
      fs.rmSync(path.dirname(stage), { recursive: true, force: true });
    }
    fs.rmSync(path.join(dir, 'list'), { force: true });
    return { files, skipped, claudeFiles };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

export function readPiece(home: string, p: { moveId: string; file: string; offset: number; length: number }): { dataBase64: string; size: number; eof: boolean } {
  const file = fileOf(home, p.moveId, p.file);
  const size = fs.statSync(file).size;
  const length = Math.max(0, Math.min(PIECE, Number(p.length) || PIECE, size - p.offset));
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, length, p.offset);
  } finally {
    fs.closeSync(fd);
  }
  return { dataBase64: buf.toString('base64'), size, eof: p.offset + length >= size };
}

export function writePiece(home: string, p: { moveId: string; file: string; offset: number; dataBase64: string }): { size: number } {
  const file = fileOf(home, p.moveId, p.file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const data = Buffer.from(String(p.dataBase64 ?? ''), 'base64');
  if (p.offset === 0) fs.writeFileSync(file, data, { mode: 0o600 });
  else {
    if (!fs.existsSync(file) || fs.statSync(file).size !== p.offset) throw new Error(`the next piece of ${p.file} does not follow what is here`);
    fs.appendFileSync(file, data);
  }
  return { size: fs.statSync(file).size };
}

async function verified(home: string, moveId: string, files: MoveFile[]): Promise<void> {
  for (const f of files) {
    const file = fileOf(home, moveId, f.name);
    if (!fs.existsSync(file) || fs.statSync(file).size !== f.size || (await sha256Of(file)) !== f.sha256) throw new Error(`${f.name} did not arrive whole`);
  }
}

/** A folder of that name inside `parent` that is not there yet (`name`, `name-2`, …). */
function freeFolder(parent: string, name: string): string {
  const base = name.replace(/[/\\]/g, '_').replace(/^\.+/, '') || 'moved';
  for (let i = 1; i < 100; i++) {
    const p = path.join(parent, i === 1 ? base : `${base}-${i}`);
    if (!fs.existsSync(p)) return p;
  }
  throw new Error(`no free folder name like ${base} in ${parent}`);
}

const jsonEscaped = (s: string) => JSON.stringify(s).slice(1, -1);

/** The conversation, put where this machine's Claude Code looks for it for `cwd`, with the old machine's paths made the new ones. */
function placeConversation(home: string, moveId: string, claudeBase: string, cwd: string, rewrite: Array<{ from: string; to: string }>): number {
  const stage = path.join(moveDir(home, moveId), 'claude-in');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  // (The conversation only: a handful of files.)
  execFileSync('tar', ['-xzf', fileOf(home, moveId, 'claude.tgz'), '-C', stage], { stdio: 'ignore', timeout: 5 * 60_000 });
  const to = claudeProjectDir(claudeBase, cwd);
  const src = path.join(stage, 'claude');
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(to, { recursive: true });
  // Longest first: a worktree inside the old folder is rewritten as itself, not as the folder plus a tail.
  const pairs = [...rewrite].filter((x) => x.from && x.from !== x.to).sort((a, b) => b.from.length - a.from.length).map((x) => [jsonEscaped(x.from), jsonEscaped(x.to)] as const);
  let placed = 0;
  const copy = (rel: string) => {
    for (const d of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, d.name) : d.name;
      const target = path.join(to, r);
      if (d.isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        copy(r);
      } else if (d.isFile()) {
        // Never over what this machine already has of that conversation.
        if (fs.existsSync(target)) continue;
        if (r.endsWith('.jsonl')) {
          let text = fs.readFileSync(path.join(src, r), 'utf8');
          for (const [from, into] of pairs) text = text.split(from).join(into);
          fs.writeFileSync(target, text, { mode: 0o600 });
        } else fs.copyFileSync(path.join(src, r), target);
        placed++;
      }
    }
  };
  copy('');
  return placed;
}

/** The new folder on this machine, and the conversation where Claude Code will find it. */
export async function unpack(home: string, p: MoveUnpackParams, claudeBase: string): Promise<MoveUnpacked> {
  await verified(home, p.moveId, p.files);
  if (!fs.statSync(p.parent, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${p.parent} is not a folder on this machine`);
  const dest = freeFolder(p.parent, p.name);
  fs.mkdirSync(dest, { recursive: false });
  try {
    if (p.kind === 'bundle') {
      const bundle = fileOf(home, p.moveId, 'repo.bundle');
      await run('git', ['init', '-q', dest]);
      await run('git', ['-C', dest, 'fetch', '-q', '--update-head-ok', bundle, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*']);
      const branches = (await run('git', ['-C', dest, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean);
      // The branch the repository had checked out (the bundle's HEAD), as the one to fall back on.
      const heads = (await run('git', ['bundle', 'list-heads', bundle]).catch(() => '')).split('\n').map((l) => l.trim().split(' '));
      const head = heads.find(([, ref]) => ref === 'HEAD')?.[0];
      const headBranch = head ? heads.find(([sha, ref]) => sha === head && ref?.startsWith('refs/heads/'))?.[1]?.slice('refs/heads/'.length) : undefined;
      const want = p.branch && branches.includes(p.branch) ? p.branch : headBranch && branches.includes(headBranch) ? headBranch : branches.includes('main') ? 'main' : branches[0];
      if (want) await run('git', ['-C', dest, 'checkout', '-q', '-f', want]);
    } else {
      await run('tar', ['-xzf', fileOf(home, p.moveId, 'folder.tgz'), '-C', dest]);
      // The office's worktrees of that repository stayed on the other machine.
      if (fs.existsSync(path.join(dest, '.git'))) await run('git', ['-C', dest, 'worktree', 'prune']).catch(() => '');
    }
    const real = fs.realpathSync(dest);
    const cwd = p.claude?.rel ? path.join(real, p.claude.rel) : real;
    if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
    let claudeFiles = 0;
    if (p.claude && p.files.some((f) => f.name === 'claude.tgz')) {
      claudeFiles = placeConversation(home, p.moveId, claudeBase, cwd, p.claude.rewrite.map((r) => ({ from: r.from, to: r.to === '<dest>' ? real : r.to.replace(/^<dest>/, real) })));
    }
    return { path: real, cwd, claudeFiles };
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

/** A moved copy's branches, brought into the repository it was copied from — as `<prefix>/<branch>`, nothing of its own overwritten. */
export async function fetchBack(home: string, p: MoveFetchBackParams, claudeBase: string): Promise<{ branches: string[]; claudeFiles: number }> {
  await verified(home, p.moveId, p.files);
  const prefix = p.prefix.replace(/[^a-zA-Z0-9/_.-]/g, '-').replace(/^\/+|\/+$/g, '') || 'moved';
  const bundle = fileOf(home, p.moveId, 'repo.bundle');
  await run('git', ['-C', p.repo, 'fetch', '-q', bundle, `+refs/heads/*:refs/heads/${prefix}/*`]);
  const branches = (await run('git', ['-C', p.repo, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`])).split('\n').filter(Boolean);
  const claudeFiles = p.claude && p.files.some((f) => f.name === 'claude.tgz') ? placeConversation(home, p.moveId, claudeBase, p.claude.cwd, p.claude.rewrite) : 0;
  return { branches, claudeFiles };
}

export function drop(home: string, moveId: string): void {
  fs.rmSync(moveDir(home, moveId), { recursive: true, force: true });
}

